"""
Test Writer Agent module for the TalkCody project.

This agent is responsible for generating comprehensive unit tests for
source code based on a user-provided task and file context. It uses
DeepSeek's function calling capability to write test files directly,
with full error handling, cost tracking, and support for both pytest
and unittest frameworks.

The agent's prompt guides DeepSeek to:
- Write comprehensive unit tests covering all code paths
- Use the appropriate test framework (pytest preferred, unittest available)
- Cover edge cases including empty inputs, invalid values, and error paths
- Include descriptive test names and docstrings explaining each test
- Follow testing best practices (fixtures, parametrization, mocking)

Typical usage (server-sent event stream)::

    from test_agent import generate_tests

    for event in generate_tests(
        task="Write tests for the auth module",
        files_context="src/auth/login.py\\nimport jwt\\n...",
    ):
        if event["type"] == "thinking":
            ...  # Stream to user
        elif event["type"] == "code":
            ...  # Show test file being written
        elif event["type"] == "done":
            ...  # Generation complete
        elif event["type"] == "error":
            ...  # Handle error
"""

import json
import os
import pathlib
from typing import Any, Dict, Generator, List, Optional

# ── Shared imports from project config ──────────────────────────────────────

from config import (
    PROJECT_ROOT,
    MODEL_PRICING,
    add_cost,
    calculate_cost,
    client,
    get_session_cost,
)


# ── Constants ─────────────────────────────────────────────────────────────────

DEFAULT_MODEL = "deepseek-chat"

BACKUP_DIR_NAME = ".test_agent_backups"
"""
Name of the directory (under project root) where original test file contents
are backed up before being overwritten.
"""

# Default test directory inside the project root
DEFAULT_TEST_DIR = "tests"


# ── Tool Definition ───────────────────────────────────────────────────────────

WRITE_FILE_TOOL: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": (
                "Write a test file with complete content. Overwrites if "
                "the file already exists. Creates parent directories "
                "automatically."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "Relative path from the project root. "
                            "Example: 'tests/test_auth_login.py'"
                        ),
                    },
                    "content": {
                        "type": "string",
                        "description": "Complete test file content to write.",
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

TEST_SYSTEM_PROMPT = """\
You are an expert software engineer specializing in writing comprehensive \
unit tests. You have been given a description of what needs to be tested and \
the source code context for the relevant files.

Your job is to write **complete, production-quality test files** using the \
``write_file`` tool.

## Testing Rules

1. **Framework**: Use **pytest** as the primary framework. Use the standard \
``unittest`` module only if the existing codebase already uses it.

2. **Coverage Requirements**:
   - Every public function and method must have at least one test.
   - Cover **normal cases** (expected inputs → correct outputs).
   - Cover **edge cases** (empty strings, zero values, ``None``, boundary \
values, empty collections, single-element collections, etc.).
   - Cover **error cases** (invalid inputs → expected exceptions).
   - Cover **null/None cases** (``None`` arguments, missing optional values).

3. **Test Structure**:
   - Use descriptive function names that clearly communicate the scenario \
being tested (e.g. ``test_login_with_valid_credentials_returns_token``).
   - Include a **docstring** on every test function explaining what is being \
tested and what the expected behaviour is.
   - Use **pytest fixtures** for shared setup where appropriate.
   - Use **pytest.mark.parametrize** for testing multiple input variants.
   - Use **pytest.raises** for testing expected exceptions.

4. **Mocking**: Use ``unittest.mock`` (or ``pytest-mock``) to isolate the \
code under test from external dependencies (database, API calls, file I/O, etc.).

5. **Imports**: Only import modules and functions that are actually used in \
the tests. Import the code under test from its actual source location.

6. **File Placement**: Place test files in the ``tests/`` directory (or an \
appropriate subdirectory), mirroring the source structure. For example, \
``src/auth/login.py`` → ``tests/test_auth_login.py``.

7. **Completeness**: Write the **entire file** — never leave placeholders, \
``TODO`` comments, or incomplete test skeletons.

8. **Existing Patterns**: If the project already has test files, match their \
style, naming conventions, and structure.

## Output

Use the ``write_file`` tool to create or update each test file. Every call \
must include the full file content.
""".strip()


# ── Prompt Builder ────────────────────────────────────────────────────────────

def _build_user_prompt(
    task: str,
    files_context: str,
) -> str:
    """Build the user prompt for the test generation API call.

    Args:
        task: The user's description of what to test.
        files_context: Context about the files under test, typically
            including source code excerpts or full file contents.

    Returns:
        A formatted prompt string ready to send to DeepSeek.
    """
    sections: List[str] = [
        "## Task",
        "",
        task,
        "",
        "## Source Code Context",
        "",
        "Below is the source code and context for the files that need tests:",
        "",
        files_context,
        "",
        (
            "Write comprehensive unit tests for the code above. Use the "
            "``write_file`` tool to create the test file(s). Provide "
            "complete file content for every test file you create."
        ),
    ]
    return "\n".join(sections)


# ── File System Helpers ───────────────────────────────────────────────────────

def _get_project_root() -> pathlib.Path:
    """Return the resolved project root directory.

    Uses ``PROJECT_ROOT`` from config if defined, otherwise falls back
    to the current working directory.

    Returns:
        The resolved project root as a ``pathlib.Path``.
    """
    if PROJECT_ROOT:
        return pathlib.Path(PROJECT_ROOT).resolve()
    return pathlib.Path.cwd().resolve()


def _resolve_path(relative_path: str) -> pathlib.Path:
    """Resolve a relative path to an absolute path under the project root.

    Args:
        relative_path: A file path relative to the project root.

    Returns:
        Absolute ``pathlib.Path`` object.

    Raises:
        ValueError: If the resolved path escapes the project root.
    """
    project_root = _get_project_root()
    target = (project_root / relative_path).resolve()

    # Security check: ensure the path doesn't escape the project root
    if not str(target).startswith(str(project_root)):
        raise ValueError(
            f"Path '{relative_path}' resolves outside the project root "
            f"'{project_root}'. Refusing to write."
        )

    return target


def _ensure_directory(path: pathlib.Path) -> None:
    """Ensure the parent directory of *path* exists, creating it if needed.

    Args:
        path: A file path whose parent directory should be created.

    Raises:
        OSError: If the directory cannot be created.
    """
    parent = path.parent
    if not parent.exists():
        parent.mkdir(parents=True, exist_ok=True)


def _write_test_file(file_path: pathlib.Path, content: str) -> None:
    """Write *content* to *file_path*, creating directories as needed.

    Args:
        file_path: The destination file path.
        content: The full text content to write.

    Raises:
        OSError: If the file cannot be written.
    """
    _ensure_directory(file_path)

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)


def _backup_existing_file(absolute_path: pathlib.Path) -> Optional[str]:
    """Back up an existing test file before overwriting it.

    The backup is stored under ``<project_root>/.test_agent_backups/``
    with a timestamp prefix so old copies are never silently overwritten.

    Args:
        absolute_path: The absolute path to the file that will be overwritten.

    Returns:
        The backup destination path if a backup was made, or ``None`` if the
        file did not exist or could not be read.
    """
    if not absolute_path.is_file():
        return None

    project_root = _get_project_root()
    backup_root = project_root / BACKUP_DIR_NAME
    backup_root.mkdir(parents=True, exist_ok=True)

    # Preserve relative path structure inside the backup directory
    try:
        relative = absolute_path.relative_to(project_root)
    except ValueError:
        relative = pathlib.Path(absolute_path.name)

    from datetime import datetime
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_root / f"{timestamp}__{relative}"
    backup_path.parent.mkdir(parents=True, exist_ok=True)

    import shutil
    try:
        shutil.copy2(str(absolute_path), str(backup_path))
        return str(backup_path)
    except (OSError, shutil.Error) as exc:
        # Non-critical: log but don't raise
        print(f"[test_agent] Warning: could not back up {absolute_path}: {exc}")
        return None


# ── Main Generator ────────────────────────────────────────────────────────────

def generate_tests(
    task: str,
    files_context: str,
    model: str = DEFAULT_MODEL,
) -> Generator[Dict[str, Any], None, None]:
    """Generate comprehensive unit tests for source code using DeepSeek
    function calling.

    This generator yields server-sent event (SSE) style dictionaries:

    - ``{"type": "thinking", "content": "..."}`` — status updates / messages
      for the user.
    - ``{"type": "code", "file": "tests/test_example.py", "content": "first 100 chars..."}``
      — emitted each time a test file is written, with a preview of the content.
    - ``{"type": "done", "content": "Tests generated.", "files": [...], "cost": 0.0}``
      — emitted once when all test files are written successfully.
    - ``{"type": "error", "content": "..."}`` — emitted on failure.

    Args:
        task: The user's description of what to test. This should describe
            the functionality, module, or feature that needs tests.
        files_context: Context about the files under test. This should
            include the source code and/or descriptions of the code that
            needs tests. Typically includes full or partial file contents.
        model: The DeepSeek model to use (default ``"deepseek-chat"``).

    Yields:
        Event dictionaries as described above.

    Raises:
        The generator catches most exceptions and yields an error event
        instead of propagating them. Unexpected critical failures may still
        propagate.

    Example::

        for event in generate_tests(
            task="Write tests for the user authentication module",
            files_context=open("src/auth/login.py").read(),
        ):
            if event["type"] == "done":
                print(f"Generated {len(event['files'])} test file(s) "
                      f"at cost ${event['cost']:.6f}")
    """
    # ── Validate inputs ───────────────────────────────────────────────────
    if not task or not task.strip():
        yield {"type": "error", "content": "Task cannot be empty."}
        return

    if not files_context or not files_context.strip():
        yield {"type": "error", "content": "Files context cannot be empty."}
        return

    if model not in MODEL_PRICING:
        supported = ", ".join(MODEL_PRICING.keys())
        yield {
            "type": "error",
            "content": (
                f"Unknown model '{model}'. Supported models: {supported}."
            ),
        }
        return

    # ── Phase 1: Initial thinking ─────────────────────────────────────────
    yield {
        "type": "thinking",
        "content": "Generating tests...",
    }

    # ── Phase 2: Check for DeepSeek API client availability ───────────────
    if client is None:
        yield {
            "type": "error",
            "content": (
                "DeepSeek API client is not configured. "
                "Ensure DEEPSEEK_API_KEY is set in the environment."
            ),
        }
        return

    # ── Phase 3: Call DeepSeek with function calling ──────────────────────
    messages = [
        {"role": "system", "content": TEST_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": _build_user_prompt(task, files_context),
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
    except Exception as exc:
        yield {
            "type": "error",
            "content": f"DeepSeek API call failed: {exc}",
        }
        return

    # ── Track cost ────────────────────────────────────────────────────────
    usage = response.usage
    call_cost = 0.0
    if usage:
        try:
            call_cost = calculate_cost(
                model, usage.prompt_tokens, usage.completion_tokens
            )
        except (KeyError, TypeError):
            # Fallback direct calculation if config's calculate_cost fails
            pricing = MODEL_PRICING.get(
                model,
                MODEL_PRICING.get("deepseek-chat", {"input": 0.27, "output": 1.10}),
            )
            input_cost = (usage.prompt_tokens / 1_000_000) * pricing["input"]
            output_cost = (usage.completion_tokens / 1_000_000) * pricing["output"]
            call_cost = input_cost + output_cost
        try:
            add_cost(call_cost)
        except Exception:
            # Non-critical: cost tracking failure should not block execution
            pass

    choice = response.choices[0]
    message = choice.message

    # ── Phase 4: Extract and execute tool calls ───────────────────────────
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
                "content": "Tool call missing 'path' argument. Skipping.",
            }
            continue

        if not file_content:
            yield {
                "type": "error",
                "content": (
                    f"Tool call for '{file_path}' has empty content. "
                    "Skipping."
                ),
            }
            continue

        # ── Resolve path & validate ─────────────────────────────────────
        try:
            absolute_path = _resolve_path(file_path)
        except ValueError as exc:
            yield {"type": "error", "content": str(exc)}
            continue

        # Optional: back up existing file
        try:
            backup_dest = _backup_existing_file(absolute_path)
            if backup_dest:
                backup_filename = pathlib.Path(backup_dest).name
                note = (
                    f"Backed up '{file_path}' to "
                    f"'{BACKUP_DIR_NAME}/{backup_filename}'."
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

        # ── Write the test file ──────────────────────────────────────────
        try:
            _write_test_file(absolute_path, file_content)
        except OSError as exc:
            yield {
                "type": "error",
                "content": f"Failed to write '{file_path}': {exc}",
            }
            continue
        except Exception as exc:
            yield {
                "type": "error",
                "content": f"Unexpected error writing '{file_path}': {exc}",
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

    # ── Phase 5: Report results ───────────────────────────────────────────
    if not written_files:
        yield {
            "type": "error",
            "content": (
                "No test files were written. The model may not have followed "
                "the instructions correctly."
            ),
        }
        return

    summary_parts = [f"Tests generated. Wrote {len(written_files)} test file(s)."]
    if backup_notes:
        summary_parts.append(
            f"Backed up {len(backup_notes)} existing file(s)."
        )

    # Get the total session cost from config's tracking
    try:
        total_cost = get_session_cost()
    except Exception:
        total_cost = call_cost

    yield {
        "type": "done",
        "content": " ".join(summary_parts),
        "files": written_files,
        "cost": round(total_cost, 8),
    }


# ── CLI Entry Point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    def _print_event(event: Dict[str, Any]) -> None:
        """Pretty-print a single event dict to the console.

        Args:
            event: An event dictionary from the ``generate_tests`` generator.
        """
        etype = event.get("type", "unknown")

        if etype == "thinking":
            print(f"🧠 {event['content']}")
        elif etype == "code":
            print(f"📄 {event.get('file', '?')}")
            content = event.get("content", "")
            if content:
                print(f"   └─ Preview: {content!r}")
        elif etype == "done":
            print(f"✅ {event['content']}")
            print(f"💰 Session cost: ${event.get('cost', 0.0):.6f}")
            files = event.get("files", [])
            if files:
                print(f"📁 Files: {', '.join(files)}")
        elif etype == "error":
            print(f"❌ {event['content']}")

    # ── Parse arguments ──────────────────────────────────────────────────
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python test_agent.py <task> [model]")
        print("")
        print("The task is read from the first argument. If not provided,")
        print("you will be prompted interactively.")
        print("")
        print("The files context is read from stdin (pipe a file or")
        print("paste the source code).")
        print("")
        print("Examples:")
        print("  python test_agent.py \"Test the auth module\" < src/auth/login.py")
        print("  echo \"def add(a,b): return a+b\" | python test_agent.py \"Test add function\"")
        sys.exit(1)

    task_arg = sys.argv[1]
    model_arg = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_MODEL

    # Read files context from stdin
    files_context_arg = sys.stdin.read().strip()

    if not files_context_arg:
        print("❌ No files context provided. Pipe source code via stdin.")
        print("   Example: python test_agent.py \"Test auth\" < src/auth/login.py")
        sys.exit(1)

    print(f"🧠 Task: {task_arg}")
    print(f"📚 Model: {model_arg}")
    print(f"📖 Context: {len(files_context_arg)} characters read from stdin")
    print()

    for event in generate_tests(task_arg, files_context_arg, model=model_arg):
        _print_event(event)
