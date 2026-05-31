"""
Coding Agent module for the TalkCody project.

This agent is responsible for implementing code changes based on a plan
provided by the Plan agent. It uses DeepSeek's function calling capability
to write files directly, with full error handling, cost tracking, and
optional file backup before overwriting.

Typical usage (server-sent event stream):
    for event in implement_changes(task, plan, model="deepseek-chat"):
        if event["type"] == "thinking":
            ...  # Stream to user
        elif event["type"] == "code":
            ...  # Show file being written
        elif event["type"] == "done":
            ...  # Implementation complete
        elif event["type"] == "error":
            ...  # Handle error
"""

import json
import os
import shutil
import openai
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

from config import (
    PROJECT_ROOT,
    MODEL_PRICING,
    add_cost,
    calculate_cost,
    client,
    get_session_cost,
    reset_session,
)

# ── Constants ─────────────────────────────────────────────────────────────────

BACKUP_DIR_NAME = ".coding_agent_backups"
"""
Name of the directory (under project root) where original file contents are
backed up before being overwritten.
"""

# ── File System Helpers ───────────────────────────────────────────────────────


def _resolve_path(relative_path: str) -> str:
    """
    Resolve a relative path to an absolute path under the project root.

    Args:
        relative_path: A file path relative to the project root.

    Returns:
        Absolute path string.

    Raises:
        ValueError: If the resolved path escapes the project root.
    """
    project_root = Path(PROJECT_ROOT).resolve()
    target = (project_root / relative_path).resolve()

    # Security check: ensure the path doesn't escape the project root
    if not str(target).startswith(str(project_root)):
        raise ValueError(
            f"Path '{relative_path}' resolves outside the project root "
            f"'{project_root}'. Refusing to write."
        )

    return str(target)


def _ensure_directory(path: str) -> None:
    """
    Ensure the parent directory of *path* exists, creating it if needed.

    Args:
        path: An absolute file path.

    Raises:
        OSError: If the directory cannot be created.
    """
    parent = Path(path).parent
    if not parent.exists():
        parent.mkdir(parents=True, exist_ok=True)


def _backup_file(absolute_path: str) -> Optional[str]:
    """
    Back up an existing file before overwriting it.

    The backup is stored under ``<project_root>/.coding_agent_backups/``
    with a timestamp prefix so old copies are never silently overwritten.

    Args:
        absolute_path: The absolute path to the file that will be overwritten.

    Returns:
        The backup destination path if a backup was made, or ``None`` if the
        file did not exist or could not be read.
    """
    source = Path(absolute_path)
    if not source.is_file():
        return None

    backup_root = Path(PROJECT_ROOT) / BACKUP_DIR_NAME
    backup_root.mkdir(parents=True, exist_ok=True)

    # Preserve relative path structure inside the backup directory
    try:
        relative = source.relative_to(Path(PROJECT_ROOT).resolve())
    except ValueError:
        relative = source.name

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_root / f"{timestamp}__{relative}"
    backup_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        shutil.copy2(str(source), str(backup_path))
        return str(backup_path)
    except (OSError, shutil.Error) as exc:
        # Non-critical: log but don't raise
        print(f"[coding_agent] Warning: could not back up {absolute_path}: {exc}")
        return None


def _write_file_content(absolute_path: str, content: str) -> None:
    """
    Write *content* to *absolute_path*, creating directories as needed.

    Args:
        absolute_path: The destination file path.
        content: The full text content to write.

    Raises:
        OSError: If the file cannot be written.
    """
    _ensure_directory(absolute_path)

    with open(absolute_path, "w", encoding="utf-8") as f:
        f.write(content)


def read_file_content(relative_path: str) -> str:
    """
    Read and return the content of a file relative to the project root.

    Args:
        relative_path: A file path relative to the project root.

    Returns:
        The complete file content as a string.

    Raises:
        FileNotFoundError: If the file does not exist.
        OSError: If the file cannot be read.
        ValueError: If the resolved path escapes the project root.
    """
    absolute_path = _resolve_path(relative_path)

    if not os.path.isfile(absolute_path):
        raise FileNotFoundError(
            f"File '{relative_path}' not found at '{absolute_path}'."
        )

    with open(absolute_path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


# ── Tool Definition ───────────────────────────────────────────────────────────

WRITE_FILE_TOOL: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write a file with complete content. Overwrites if "
                           "the file already exists. Creates parent directories "
                           "automatically.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from the project root. "
                                       "Example: 'src/components/Button.tsx'",
                    },
                    "content": {
                        "type": "string",
                        "description": "Complete file content to write.",
                    },
                },
                "required": ["path", "content"],
            },
        },
    }
]
"""
The ``write_file`` function tool definition passed to DeepSeek.
The model will return structured tool calls that this module executes.
"""


# ── System Prompt ─────────────────────────────────────────────────────────────

CODING_SYSTEM_PROMPT = """
You are an expert software engineer implementing code changes.

You have been given:
1. A **task** describing what the user wants.
2. A **plan** describing exactly which files to modify and how.

Your job is to implement the plan by using the ``write_file`` tool.

**Rules:**
- Write **complete** file content every time — never partial diffs or placeholders.
- Create new files as needed; the tool handles directory creation.
- If a plan step says "modify file X" you MUST re-read its current content from
  the codebase shown in the conversation, apply your changes, and write the
  full new version.
- Follow the existing code style, naming conventions, and patterns visible in
  the codebase.
- Add appropriate error handling, input validation, and docstrings.
- If information is missing, use reasonable defaults and note them in comments.
- Do **not** invent files the plan didn't ask for.

Use the ``write_file`` tool for every file you need to create or update.
""".strip()


# ── Main Generator ────────────────────────────────────────────────────────────

def implement_changes(
    task: str,
    plan: str,
    model: str = "deepseek-chat",
) -> Generator[Dict[str, Any], None, None]:
    """
    Implement code changes based on a task and a plan using DeepSeek function
    calling.

    This generator yields server-sent event (SSE) style dictionaries:

    - ``{"type": "thinking", "content": "..."}`` — status updates / messages
      for the user.
    - ``{"type": "code", "file": "path/to/file.py", "content": "first 100 chars..."}``
      — emitted each time a file is written, with a preview of the content.
    - ``{"type": "done", "content": "Implementation complete.", "files": [...], "cost": 0.0}``
      — emitted once when all changes are applied successfully.
    - ``{"type": "error", "content": "..."}`` — emitted on failure.

    Args:
        task: The user's original task description.
        plan: The implementation plan produced by the Plan agent. This should
              describe what files to change and how.
        model: The DeepSeek model to use (default ``"deepseek-chat"``).

    Yields:
        Event dictionaries as described above.

    Raises:
        The generator catches most exceptions and yields an error event
        instead of propagating them. Unexpected critical failures may still
        propagate.
    """
    # ── Validate inputs ───────────────────────────────────────────────────
    if not task or not task.strip():
        yield {"type": "error", "content": "Task cannot be empty."}
        return

    if not plan or not plan.strip():
        yield {"type": "error", "content": "Plan cannot be empty."}
        return

    if model not in MODEL_PRICING:
        yield {
            "type": "error",
            "content": (
                f"Unknown model '{model}'. Supported models: "
                f"{', '.join(MODEL_PRICING.keys())}."
        )}
        return

    # ── Phase 1: Initial thinking ─────────────────────────────────────────
    yield {
        "type": "thinking",
        "content": "Implementing changes based on the plan...",
    }

    # ── Phase 2: Call DeepSeek with function calling ──────────────────────
    messages = [
        {"role": "system", "content": CODING_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"## Task\n\n{task}\n\n"
                f"## Plan\n\n{plan}\n\n"
                "Implement the changes described in the plan using the "
                "``write_file`` tool. Provide complete file content for "
                "every file you create or modify."
            ),
        },
    ]

    try:
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=WRITE_FILE_TOOL,
            tool_choice="auto",
            temperature=0.2,
        )
    except openai.APIError as exc:
        yield {
            "type": "error",
            "content": f"DeepSeek API error: {exc}",
        }
        return
    except Exception as exc:
        yield {
            "type": "error",
            "content": f"Unexpected error during API call: {exc}",
        }
        return

    # ── Track cost ────────────────────────────────────────────────────────
    usage = response.usage
    if usage:
        cost = calculate_cost(model, usage.prompt_tokens, usage.completion_tokens)
        add_cost(cost)
    else:
        cost = 0.0

    choice = response.choices[0]
    message = choice.message

    # ── Phase 3: Extract and execute tool calls ───────────────────────────
    tool_calls = message.tool_calls
    if not tool_calls:
        # The model didn't call write_file — yield the text response as error
        text_response = message.content or (
            "The model did not produce any tool calls. "
            "It may not have understood the request."
        )
        yield {
            "type": "error",
            "content": text_response,
        }
        return

    written_files: List[str] = []
    backup_notes: List[str] = []

    for tool_call in tool_calls:
        if tool_call.function.name != "write_file":
            yield {
                "type": "thinking",
                "content": (
                    f"Ignoring unexpected tool call: "
                    f"'{tool_call.function.name}'."
                ),
            }
            continue

        # ── Parse arguments ──────────────────────────────────────────────
        try:
            args = json.loads(tool_call.function.arguments)
        except json.JSONDecodeError as exc:
            yield {
                "type": "error",
                "content": (
                    f"Failed to parse tool call arguments: {exc}. "
                    f"Raw: {tool_call.function.arguments!r}"
                ),
            }
            continue

        file_path = args.get("path", "").strip()
        file_content = args.get("content", "")

        if not file_path:
            yield {
                "type": "error",
                "content": (
                    "Tool call missing 'path' argument. Skipping."
                ),
            }
            continue

        # ── Resolve & write ──────────────────────────────────────────────
        try:
            absolute_path = _resolve_path(file_path)
        except ValueError as exc:
            yield {"type": "error", "content": str(exc)}
            continue

        # Optional: back up existing file
        try:
            backup_path = _backup_file(absolute_path)
            if backup_path:
                note = (
                    f"Backed up '{file_path}' to "
                    f"'{BACKUP_DIR_NAME}/{Path(backup_path).name}'."
                )
                backup_notes.append(note)
                yield {"type": "thinking", "content": note}
        except Exception as exc:
            # Non-critical — log and continue
            yield {
                "type": "thinking",
                "content": (
                    f"Warning: could not back up '{file_path}': {exc}"
                ),
            }

        # Write the file
        try:
            _write_file_content(absolute_path, file_content)
        except OSError as exc:
            yield {
                "type": "error",
                "content": (
                    f"Failed to write '{file_path}': {exc}"
                ),
            }
            continue
        except Exception as exc:
            yield {
                "type": "error",
                "content": (
                    f"Unexpected error writing '{file_path}': {exc}"
                ),
            }
            continue

        written_files.append(file_path)

        # Yield code event with content preview (first 100 characters)
        preview = file_content[:100]
        yield {
            "type": "code",
            "file": file_path,
            "content": preview,
        }

    # ── Phase 4: Report results ──────────────────────────────────────────
    if not written_files:
        yield {
            "type": "error",
            "content": (
                "No files were written. The model may not have followed "
                "the plan correctly."
            ),
        }
        return

    summary_parts = [f"Implementation complete. Wrote {len(written_files)} file(s)."]
    if backup_notes:
        summary_parts.append(
            f"Backed up {len(backup_notes)} existing file(s)."
        )

    yield {
        "type": "done",
        "content": " ".join(summary_parts),
        "files": written_files,
        "cost": round(get_session_cost(), 8),
    }


# ── CLI Entry Point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    task_arg = sys.argv[1] if len(sys.argv) > 1 else (
        input("Task: ").strip()
    )
    plan_arg = sys.argv[2] if len(sys.argv) > 2 else (
        input("Plan: ").strip()
    )
    model_arg = sys.argv[3] if len(sys.argv) > 3 else "deepseek-chat"

    for event in implement_changes(task_arg, plan_arg, model_arg):
        etype = event["type"]
        if etype == "thinking":
            print(f"🧠 {event['content']}")
        elif etype == "code":
            print(f"📄 {event['file']}")
            if "content" in event:
                print(f"   └─ Preview: {event['content']!r}")
        elif etype == "done":
            print(f"✅ {event['content']}")
            print(f"💰 Session cost: ${event['cost']:.6f}")
            print(f"📁 Files: {', '.join(event.get('files', []))}")
        elif etype == "error":
            print(f"❌ {event['content']}")
