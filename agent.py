"""
Orchestrator Agent — Tool-Calling Loop for the TalkCody system.

This module replaces the old intent-classification pattern with a modern
tool-calling orchestrator.  DeepSeek receives a list of available tools and
calls them step by step, showing its reasoning along the way.  The loop
continues until the model produces a final answer with no more tool calls.

Architecture
------------
All sub-agents exist as separate modules in the project:

- ``explore_agent.py``    — explore_file, web_search, explore_project
- ``plan_agent.py``       — generate_plan
- ``coding_agent.py``     — implement_changes, read_file_content, write_file
- ``review_agent.py``     — review_changes, review_project
- ``document_agent.py``   — generate_docs, generate_readme
- ``test_agent.py``       — generate_tests
- ``memory.py``           — memory_read, memory_write

Shared configuration lives in ``config.py``.  This module re-exports
the key symbols so that sub-agents (especially ``plan_agent.py``) can
import them from here without creating circular dependencies.

Event Protocol
--------------
Every generator in this system yields ``dict`` objects with at least a
``"type"`` key.  Common types:

- ``thinking``       — Progress / status message shown to the user.
- ``plan``           — A structured implementation plan (from plan_agent).
- ``code``           — A file being created or modified (from coding_agent).
- ``action``         — A non-code action taken (e.g. git push).
- ``review``         — A code review result (from review_agent).
- ``document``       — Generated documentation (from document_agent).
- ``question``       — A question directed at the user (e.g. plan approval).
- ``search_results`` — Web search results (from explore_agent).
- ``file``           — File contents (from explore_agent).
- ``file_listing``   — A list of project files (from explore_agent).
- ``memory``         — Memory operation result.
- ``todo``           — Todo list operation result.
- ``pr``             — Pull-request URL.
- ``branch``         — Branch name.
- ``deploy``         — Deployment status.
- ``done``           — Signals completion of a phase or the whole flow.
- ``error``          — An error occurred.

Usage
-----
.. code-block:: python

    from agent import run_agent

    for event in run_agent("Add a dark mode toggle"):
        if event["type"] == "thinking":
            print(f"🧠 {event['content']}")
        elif event["type"] == "done":
            print(f"✅ {event['content']}  (cost: ${event['cost']:.6f})")
        elif event["type"] == "error":
            print(f"❌ {event['content']}")
"""

# ── Standard Library ──────────────────────────────────────────────────────────

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Tuple

# ── Third-Party ───────────────────────────────────────────────────────────────

from git import Repo, GitCommandError
import requests

# ─── Re-export from config ────────────────────────────────────────────────────
# These are imported by plan_agent.py via ``from agent import ...``
# so they MUST be available at module level in this file.

from config import (                                        # noqa: F401 – re-exported for plan_agent
    client,
    calculate_cost,
    add_cost,
    get_session_cost,
    reset_session,
    MODEL_PRICING,
    PROJECT_ROOT,
    GIT_TOKEN,
    GITHUB_REPO,
    DEFAULT_MODEL,
)

# ─── Sub-agent imports ────────────────────────────────────────────────────────

from explore_agent import explore_file, web_search, explore_project
from plan_agent import generate_plan
from coding_agent import implement_changes, read_file_content
from review_agent import review_changes, review_project
from document_agent import generate_docs
from test_agent import generate_tests
import memory as memory_module


# ========================================================================
#  CONSTANTS
# ========================================================================

_MAX_ITERATIONS = 20
"""Maximum number of tool-calling iterations per request."""

_IGNORE_DIRS = {
    ".git", "__pycache__", "venv", ".venv", "node_modules",
    ".idea", ".vscode", "dist", "build", ".egg-info",
    ".tox", ".mypy_cache", ".pytest_cache", ".coding_agent_backups",
}
_TEXT_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".scss",
    ".json", ".md", ".yml", ".yaml", ".txt", ".toml", ".ini", ".cfg",
    ".env", ".gitignore", ".sql", ".sh", ".bat", ".xml", ".vue",
    ".rb", ".php", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
}


# ========================================================================
#  SYSTEM PROMPT FOR THE TOOL-CALLING AGENT
# ========================================================================

_SYSTEM_PROMPT = """\
You are an expert AI coding assistant. You have access to a set of tools that \
allow you to read, write, explore, and manage code.

**How to use tools:**
- Think step by step about what needs to be done.
- Call ONE tool at a time. Each tool call returns results you can use.
- Show your reasoning before and after each tool call.
- Continue calling tools until the task is complete.
- When you are finished, provide a clear summary of what was done.

**Rules:**
- Always read a file before writing to it, unless you are creating a new file.
- Use `explore_project` first to understand the project structure when relevant.
- Commit changes with meaningful messages after writing code.
- Push to remote only when explicitly requested or when the task requires it.
- Generate documentation and tests as appropriate for the task.
- You can review code at any point to check quality.
- Max 20 tool calls per request. Be efficient.

**Available tools:**"""


# ========================================================================
#  TOOL DEFINITIONS (DeepSeek Function Calling)
# ========================================================================

def _build_available_tools() -> List[Dict[str, Any]]:
    """Return the list of function-calling tool definitions for DeepSeek.

    Each tool follows the OpenAI/DeepSeek function-calling schema with
    ``type: "function"`` and a ``function`` block containing the name,
    description, and parameter schema.
    """
    return [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the contents of a file from the project. "
                               "Provide the relative path from the project root.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Relative path to the file (e.g. 'src/main.py').",
                        },
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create or overwrite a file with new content. "
                               "Use this to implement code changes. "
                               "Parent directories are created automatically.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Relative path from project root (e.g. 'src/button.py').",
                        },
                        "content": {
                            "type": "string",
                            "description": "The complete file content to write.",
                        },
                    },
                    "required": ["path", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "explore_project",
                "description": "Walk the project directory and list all files. "
                               "Also reads the most important files for context. "
                               "Use this to understand the project structure.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web using DuckDuckGo. "
                               "Use this to find documentation, examples, or troubleshooting info.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query string.",
                        },
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_todos",
                "description": "Read the list of current todo items from memory.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_todo",
                "description": "Add or update a todo item in the todo list.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "The todo item content (e.g. 'Fix login bug').",
                        },
                        "status": {
                            "type": "string",
                            "enum": ["pending", "done"],
                            "description": "Set to 'done' to mark a todo as completed, "
                                           "'pending' to add a new one.",
                        },
                    },
                    "required": ["content", "status"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "git_commit",
                "description": "Stage all changes and commit them with a message. "
                               "Creates a new branch automatically based on the commit message.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": {
                            "type": "string",
                            "description": "The commit message describing the changes.",
                        },
                    },
                    "required": ["message"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "git_push",
                "description": "Push the current branch to the remote repository.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "branch_name": {
                            "type": "string",
                            "description": "The branch name to push. "
                                           "Usually the one created by git_commit.",
                        },
                    },
                    "required": ["branch_name"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "create_pull_request",
                "description": "Create a GitHub Pull Request from the current branch.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "The title of the pull request.",
                        },
                    },
                    "required": ["title"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "rollback_commit",
                "description": "Revert the last commit on the default branch. "
                               "Use this to undo the most recent change.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "review_files",
                "description": "Review one or more files for bugs, security issues, "
                               "performance problems, and code quality.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "files_json": {
                            "type": "string",
                            "description": "A JSON array of relative file paths "
                                           "to review (e.g. '[\"src/main.py\", \"src/utils.py\"]').",
                        },
                        "task": {
                            "type": "string",
                            "description": "What to focus the review on",
                        },
                    },
                    "required": ["files_json"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Edit specific parts of a file by finding text and replacing it. "
                               "Use this when you want to make targeted changes without rewriting "
                               "the entire file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Relative path to the file",
                        },
                        "old_text": {
                            "type": "string",
                            "description": "The exact text to find and replace",
                        },
                        "new_text": {
                            "type": "string",
                            "description": "The replacement text",
                        },
                    },
                    "required": ["path", "old_text", "new_text"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_files",
                "description": "Search for text patterns across all files in the project.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "description": "The text pattern to search for",
                        },
                        "file_pattern": {
                            "type": "string",
                            "description": "Optional: only search files matching this pattern "
                                           "(e.g. *.js, *.py)",
                        },
                    },
                    "required": ["pattern"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "generate_docs",
                "description": "Generate comprehensive documentation for a feature or the project. "
                               "Provide a clear task description of what to document.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "Description of what to document "
                                           "(e.g. 'Document the auth module API').",
                        },
                    },
                    "required": ["task"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "generate_tests",
                "description": "Generate unit tests for a feature or module. "
                               "Provide a clear task description of what to test.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "Description of what to test "
                                           "(e.g. 'Write tests for the login endpoint').",
                        },
                    },
                    "required": ["task"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "review_project",
                "description": "Review ALL files in the entire project for bugs, security issues, "
                               "performance problems, and code quality. Use this instead of "
                               "review_files when you want to review the whole codebase.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "What to focus the review on (e.g. 'Check for security vulnerabilities')",
                        },
                    },
                    "required": [],
                },
            },
        },
    ]


# ========================================================================
#  TOOL EXECUTORS
# ========================================================================

def _collect_generator_events(
    gen: Generator[Dict[str, Any], None, None],
    events: List[Dict[str, Any]],
) -> str:
    """Iterate a sub-agent generator, collecting all events and returning a result string.

    Parameters
    ----------
    gen : Generator[Dict, None, None]
        The sub-agent generator to run.
    events : list
        The event list to append to (already has the initial thinking event).

    Returns
    -------
    str
        A text representation of the result, suitable for sending back to DeepSeek.
    """
    result_lines: List[str] = []
    for event in gen:
        events.append(event)
        etype = event.get("type", "")
        if etype == "file":
            path = event.get("path", "?")
            content = event.get("content", "")
            result_lines.append(f"### {path}\n\n```\n{content}\n```")
        elif etype == "file_listing":
            files = event.get("files", [])
            result_lines.append(f"Project contains {event.get('total', len(files))} files.")
            result_lines.append("\n".join(files[:200]))
            if len(files) > 200:
                result_lines.append(f"... and {len(files) - 200} more files.")
        elif etype == "search_results":
            results = event.get("results", [])
            if results:
                for i, r in enumerate(results, 1):
                    result_lines.append(f"{i}. **{r.get('title', 'Untitled')}**")
                    result_lines.append(f"   URL: {r.get('url', 'N/A')}")
                    snippet = r.get('snippet', '')
                    if snippet:
                        result_lines.append(f"   > {snippet[:300]}")
            else:
                result_lines.append("No search results found.")
        elif etype == "review":
            result_lines.append(f"### Review: {event.get('file', '?')}")
            result_lines.append(f"Score: {event.get('score', '?')}/100")
            issues = event.get("issues", [])
            for issue in issues:
                sev = issue.get("severity", "low").upper()
                desc = issue.get("description", issue.get("message", ""))
                result_lines.append(f"[{sev}] {desc}")
        elif etype == "document":
            title = event.get("title", "Documentation")
            content = event.get("content", "")
            result_lines.append(f"### {title}")
            result_lines.append(content[:5000])
        elif etype == "code":
            fpath = event.get("file", "?")
            result_lines.append(f"Written: {fpath}")
        elif etype == "plan":
            steps = event.get("steps", [])
            result_lines.append(f"Plan: {event.get('summary', '')}")
            for i, step in enumerate(steps, 1):
                result_lines.append(f"  {i}. {step.get('description', str(step))}")
        elif etype == "action":
            result_lines.append(f"✅ {event.get('content', '')}")
        elif etype == "pr":
            result_lines.append(f"Pull Request: {event.get('url', '')}")
        elif etype == "branch":
            result_lines.append(f"🌿 Branch: {event.get('name', '')}")
        elif etype == "deploy":
            result_lines.append(f"🚀 Deploy: {event.get('content', '')}")
        elif etype == "question":
            result_lines.append(f"❓ Question: {event.get('content', '')}")
        elif etype == "done":
            msg = event.get("message") or event.get("content", "")
            if msg:
                result_lines.append(f"✅ {msg}")
        elif etype == "error":
            result_lines.append(f"❌ {event.get('content', 'Unknown error')}")

    if not result_lines:
        return "Operation completed (no detailed result available)."
    return "\n\n".join(result_lines)


def _execute_read_file(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``read_file`` tool.

    Iterates the explore_file generator internally, captures the file
    content for DeepSeek, and yields only ``thinking`` events to the
    UI stream — NOT the full file content.
    """
    path = args["path"]
    events.append({"type": "thinking", "content": f"📖 Reading {path}..."})
    content = ""
    for event in explore_file(path):
        if event["type"] == "file":
            content = event.get("content", "")
        elif event["type"] == "error":
            events.append(event)
            return ""
    events.append({"type": "thinking", "content": f"📖 Read {path}"})
    return content


def _execute_write_file(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``write_file`` tool."""
    path = args["path"]
    content = args["content"]
    events.append({"type": "thinking", "content": f"✍️ Writing file: {path}..."})
    try:
        abs_path = (PROJECT_ROOT / path).resolve()
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_text(content, encoding="utf-8")
        preview = content[:100].replace("\n", "\\n")
        events.append({
            "type": "code",
            "file": path,
            "content": preview,
        })
        events.append({"type": "done", "content": f"Written {path} ({len(content)} chars)."})
        return f"Successfully wrote {path} ({len(content)} characters)."
    except OSError as e:
        err = f"Failed to write {path}: {e}"
        events.append({"type": "error", "content": err})
        return err


def _execute_explore_project(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``explore_project`` tool."""
    events.append({"type": "thinking", "content": "🔍 Exploring project structure..."})
    gen = explore_project()
    return _collect_generator_events(gen, events)


def _execute_web_search(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``web_search`` tool."""
    query = args["query"]
    events.append({"type": "thinking", "content": f"🌐 Searching web for: {query}"})
    gen = web_search(query)
    return _collect_generator_events(gen, events)


def _execute_read_todos(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``read_todos`` tool."""
    events.append({"type": "thinking", "content": "📋 Reading todos..."})
    todos = memory_module.memory_read(target="topic", scope="project", file_name="todos")
    if todos and todos.strip():
        events.append({"type": "todo", "operation": "list", "content": todos})
        return f"Current todos:\n\n{todos}"
    return "No todos found."


def _execute_write_todo(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``write_todo`` tool."""
    content = args["content"]
    status = args.get("status", "pending")
    events.append({"type": "thinking", "content": f"📋 {'Completing' if status == 'done' else 'Adding'} todo: {content}"})

    if status == "done":
        # Mark as done by rewriting with [x]
        all_todos = memory_module.memory_read(target="topic", scope="project", file_name="todos")
        if content in all_todos:
            updated = all_todos.replace(f"- [ ] {content}", f"- [x] {content}")
            success = memory_module.memory_write(
                target="topic", scope="project", content=updated, file_name="todos", mode="replace"
            )
        else:
            success = memory_module.memory_write(
                target="topic", scope="project",
                content=f"- [x] {content}\n", file_name="todos", mode="append"
            )
    else:
        success = memory_module.memory_write(
            target="topic", scope="project",
            content=f"- [ ] {content}\n", file_name="todos", mode="append"
        )

    if success:
        events.append({"type": "todo", "operation": "add", "content": content})
        return f"Todo {'completed' if status == 'done' else 'added'}: {content}"
    return f"Failed to update todo: {content}"


def _execute_git_commit(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``git_commit`` tool."""
    message = args["message"]
    events.append({"type": "thinking", "content": f"✅ Committing changes: {message}"})
    gen = _git_commit_and_push(message, push=False, branch_name=_sanitise_branch_name(message))
    return _collect_generator_events(gen, events)


def _execute_git_push(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``git_push`` tool."""
    branch_name = args["branch_name"]
    events.append({"type": "thinking", "content": f"🚀 Pushing branch '{branch_name}' to remote..."})

    try:
        repo = Repo(str(PROJECT_ROOT))
        origin = repo.remotes.origin
        repo_url = f"https://x-access-token:{GIT_TOKEN}@github.com/{GITHUB_REPO}.git"
        origin.set_url(repo_url)
        origin.push(branch_name)
        events.append({"type": "action", "content": f"Pushed '{branch_name}' to remote."})
        return f"Successfully pushed branch '{branch_name}' to remote."
    except GitCommandError as e:
        err = f"Push failed: {e}"
        events.append({"type": "error", "content": err})
        return err
    except Exception as e:
        err = f"Push failed: {e}"
        events.append({"type": "error", "content": err})
        return err


def _execute_create_pull_request(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``create_pull_request`` tool."""
    title = args["title"]
    events.append({"type": "thinking", "content": f"📦 Creating pull request: {title}"})

    # Determine current branch name
    try:
        repo = Repo(str(PROJECT_ROOT))
        branch_name = repo.active_branch.name
    except Exception:
        branch_name = _sanitise_branch_name(title)

    pr_url = create_pull_request(branch_name, title)
    if pr_url:
        events.append({"type": "pr", "url": pr_url})
        return f"Pull Request created: {pr_url}"
    else:
        err = "PR creation failed (check GIT_TOKEN and GITHUB_REPO settings)."
        events.append({"type": "error", "content": err})
        return err


def _execute_rollback_commit(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``rollback_commit`` tool."""
    events.append({"type": "thinking", "content": "⏪ Rolling back last commit..."})
    gen = rollback_changes(push=True)
    return _collect_generator_events(gen, events)


def _execute_review_files(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``review_files`` tool."""
    files_json = args.get("files_json", "[]")
    task = args.get("task", "Review code changes")
    model = args.get("model", DEFAULT_MODEL)

    # Handle both JSON string and already-parsed list
    if isinstance(files_json, list):
        files = [str(f) for f in files_json]
    elif isinstance(files_json, str):
        files_json_clean = files_json.strip()
        if files_json_clean.startswith("["):
            try:
                parsed = json.loads(files_json_clean)
                if isinstance(parsed, list):
                    files = [str(f) for f in parsed]
                else:
                    files = [files_json_clean]
            except (json.JSONDecodeError, TypeError):
                files = [files_json_clean]
        else:
            files = [files_json_clean]
    else:
        files = [str(files_json)]

    # Ensure all elements are strings for safe join
    files = [str(f) for f in files]
    files_str = ", ".join(files[:5])
    events.append({"type": "thinking", "content": f"🔍 Reviewing {len(files)} file(s): {files_str}..."})

    gen = review_changes(files, task, model=model)
    return _collect_generator_events(gen, events)


def _execute_edit_file(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``edit_file`` tool."""
    path = args["path"]
    old_text = args["old_text"]
    new_text = args["new_text"]

    abs_path = PROJECT_ROOT / path
    if not abs_path.exists():
        events.append({"type": "error", "content": f"File not found: {path}"})
        return f"Error: File not found: {path}"

    content = abs_path.read_text(encoding="utf-8", errors="replace")
    if old_text not in content:
        events.append({"type": "error", "content": f"Could not find specified text in {path}"})
        return f"Error: Could not find specified text in {path}"

    new_content = content.replace(old_text, new_text, 1)
    abs_path.write_text(new_content, encoding="utf-8")

    events.append({"type": "thinking", "content": f"✍️ Edited {path}"})
    return f"Successfully edited {path}"


def _execute_search_files(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``search_files`` tool."""
    pattern = args["pattern"]
    file_pattern = args.get("file_pattern", "*")

    events.append({"type": "thinking", "content": f"🔍 Searching for '{pattern}'..."})

    results = []
    for f in PROJECT_ROOT.rglob(file_pattern):
        if any(part.startswith('.') or part == '__pycache__' or part == 'venv' or part == 'node_modules' for part in f.parts):
            continue
        if f.is_file():
            try:
                content = f.read_text(encoding="utf-8", errors="replace")
                if pattern in content:
                    # Find line numbers
                    lines = content.split('\n')
                    for i, line in enumerate(lines, 1):
                        if pattern in line:
                            rel = f.relative_to(PROJECT_ROOT)
                            results.append(f"{rel}:{i}: {line.strip()[:200]}")
            except:
                pass

    if results:
        result_text = f"Found {len(results)} match(es):\n" + "\n".join(results[:50])
        if len(results) > 50:
            result_text += f"\n... and {len(results)-50} more matches"
    else:
        result_text = f"No matches found for '{pattern}'"

    events.append({"type": "thinking", "content": f"🔍 Search complete: {len(results)} match(es)"})
    return result_text


def _execute_generate_docs(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``generate_docs`` tool."""
    task = args["task"]
    events.append({"type": "thinking", "content": f"📝 Generating documentation for: {task}..."})

    # Build files context automatically
    files_context = _build_files_context(task)
    gen = generate_docs(task, files_context)
    return _collect_generator_events(gen, events)


def _execute_generate_tests(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``generate_tests`` tool."""
    task = args["task"]
    events.append({"type": "thinking", "content": f"🧪 Generating tests for: {task}..."})

    # Build files context automatically
    files_context = _build_files_context(task)
    gen = generate_tests(task, files_context)
    return _collect_generator_events(gen, events)


def _execute_review_project(
    args: Dict[str, Any],
    events: List[Dict[str, Any]],
) -> str:
    """Execute the ``review_project`` tool."""
    task = args.get("task", "Review the entire project")
    model = args.get("model", DEFAULT_MODEL)

    events.append({"type": "thinking", "content": "🔍 Reviewing entire project..."})

    gen = review_project(task, model=model)
    return _collect_generator_events(gen, events)


# ── Tool Handler Registry ────────────────────────────────────────────────────

_TOOL_HANDLERS: Dict[str, Any] = {
    "read_file": _execute_read_file,
    "write_file": _execute_write_file,
    "explore_project": _execute_explore_project,
    "web_search": _execute_web_search,
    "read_todos": _execute_read_todos,
    "write_todo": _execute_write_todo,
    "git_commit": _execute_git_commit,
    "git_push": _execute_git_push,
    "create_pull_request": _execute_create_pull_request,
    "rollback_commit": _execute_rollback_commit,
    "review_files": _execute_review_files,
    "edit_file": _execute_edit_file,
    "search_files": _execute_search_files,
    "generate_docs": _execute_generate_docs,
    "generate_tests": _execute_generate_tests,
    "review_project": _execute_review_project,
}


# ========================================================================
#  TOOL EXECUTION DISPATCHER
# ========================================================================

def _execute_tool(
    tool_name: str,
    tool_args: Dict[str, Any],
) -> Tuple[List[Dict[str, Any]], str]:
    """Execute a tool by name with the given arguments.

    Parameters
    ----------
    tool_name : str
        The name of the tool to execute.
    tool_args : dict
        The arguments to pass to the tool handler.

    Returns
    -------
    tuple
        ``(events, result_string)`` — the list of events to yield to the
        SSE stream, and the text result to send back to DeepSeek.
    """
    handler = _TOOL_HANDLERS.get(tool_name)
    if not handler:
        err = f"Unknown tool: '{tool_name}'."
        return [{"type": "error", "content": err}], err

    events: List[Dict[str, Any]] = []
    try:
        result = handler(tool_args, events)
        return events, result
    except Exception as exc:
        err = f"Tool '{tool_name}' execution failed: {exc}"
        events.append({"type": "error", "content": err})
        import traceback
        traceback.print_exc()
        return events, err


# ========================================================================
#  FILES CONTEXT BUILDER
# ========================================================================

def _build_files_context(task: str) -> str:
    """Build a text representation of the project's files for context.

    Walks the project tree and reads important files, then formats them
    as a string suitable for passing to ``generate_docs`` or
    ``generate_tests``.

    Parameters
    ----------
    task : str
        The task description (used to scope which files to include).

    Returns
    -------
    str
        A formatted string containing file paths and contents.
    """
    IMPORTANT = {
        "index.html", "app.js", "main.js", "style.css", "package.json",
        "README.md", "requirements.txt", "config.py", "agent.py",
        "server.py", "pyproject.toml",
    }

    root_path = Path(PROJECT_ROOT).resolve()
    all_files: List[Path] = []
    for f in root_path.rglob("*"):
        try:
            rel = f.relative_to(root_path)
        except ValueError:
            continue
        if any(part in _IGNORE_DIRS for part in rel.parts):
            continue
        if f.is_file() and f.suffix.lower() in _TEXT_EXTENSIONS:
            all_files.append(f)

    all_files.sort(
        key=lambda f: (
            0 if f.name in IMPORTANT else 1,
            str(f.relative_to(root_path)).lower(),
        ),
    )

    sections: List[str] = []
    total_chars = 0
    max_chars = 100_000
    max_files = 30

    for f in all_files:
        if len(sections) >= max_files or total_chars >= max_chars:
            break
        try:
            rel = str(f.relative_to(root_path))
            content = f.read_text(encoding="utf-8", errors="replace")
            if len(content) > 10_000:
                content = content[:10_000] + "\n# … (truncated)"
            sections.append(f"--- {rel} ---\n{content}")
            total_chars += len(content)
        except (OSError, PermissionError):
            continue

    return "\n\n".join(sections)


# ========================================================================
#  GIT / GITHUB HELPERS
# ========================================================================

def _sanitise_branch_name(task: str, max_len: int = 48) -> str:
    """Turn a task description into a valid git branch name.

    Parameters
    ----------
    task : str
        The original task description.
    max_len : int, optional
        Maximum length of the sanitised branch name (default 48).

    Returns
    -------
    str
        A branch-friendly string prefixed with ``agent/``.
    """
    safe = re.sub(r"[^a-z0-9]+", "-", task.lower()).strip("-")
    return f"agent/{safe[:max_len]}"


def get_repo() -> Tuple[Repo, Any]:
    """Open the Git repository at :data:`PROJECT_ROOT` and return it along
    with the ``origin`` remote.

    Returns
    -------
    tuple
        ``(repo, origin)`` — a ``git.Repo`` instance and its ``origin`` remote.

    Raises
    ------
    GitCommandError
        If the directory is not a valid Git repository or has no remote.
    """
    repo = Repo(str(PROJECT_ROOT))
    origin = repo.remotes.origin
    return repo, origin


def create_pull_request(branch: str, title: str) -> str:
    """Create a pull request on GitHub via the REST API.

    Parameters
    ----------
    branch : str
        The head branch name (e.g. ``\"agent/add-dark-mode\"``).
    title : str
        The PR title (will be prefixed with ``\"AI agent: \"``).

    Returns
    -------
    str
        The HTML URL of the created pull request, or an empty string on
        failure.
    """
    if not GIT_TOKEN or not GITHUB_REPO:
        print("[agent] GIT_TOKEN or GITHUB_REPO not set — cannot create PR.")
        return ""

    url = f"https://api.github.com/repos/{GITHUB_REPO}/pulls"
    headers = {
        "Authorization": f"Bearer {GIT_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    }
    data = {
        "title": f"AI agent: {title[:50]}",
        "head": branch,
        "base": "main",
        "body": (
            f"Automatically generated by the AI agent.\n\n"
            f"**Task:** {title}\n\n"
            f"This PR was created by the TalkCody Orchestrator Agent."
        ),
    }

    # Try "main" first; if that fails, try "master"
    for base_branch in ("main", "master"):
        data["base"] = base_branch
        try:
            resp = requests.post(url, json=data, headers=headers, timeout=30)
            if resp.status_code == 201:
                return resp.json().get("html_url", "")
            if resp.status_code != 422:  # 422 = validation error, try next base
                print(
                    f"[agent] PR creation failed ({resp.status_code}): "
                    f"{resp.text[:200]}"
                )
                return ""
        except requests.RequestException as exc:
            print(f"[agent] PR creation request failed: {exc}")
            return ""

    print("[agent] Could not create PR — neither 'main' nor 'master' worked.")
    return ""


def auto_deploy(branch: str) -> Generator[Dict[str, Any], None, None]:
    """Merge the pull request for *branch* via squash and trigger deployment.

    Finds the open PR associated with *branch* and merges it using the
    GitHub squash-merge API.

    Parameters
    ----------
    branch : str
        The head branch name whose PR should be merged.

    Yields
    ------
    dict
        Events: ``thinking``, ``action``, ``deploy``, ``error``.
    """
    if not GIT_TOKEN or not GITHUB_REPO:
        yield {"type": "error", "content": "GitHub token or repo not configured."}
        return

    yield {"type": "thinking", "content": "Merging pull request via squash…"}

    headers = {
        "Authorization": f"Bearer {GIT_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    }

    # ── Find open PR for this branch ────────────────────────────────────
    owner = GITHUB_REPO.split("/")[0]
    list_url = (
        f"https://api.github.com/repos/{GITHUB_REPO}/pulls"
        f"?head={owner}:{branch}&state=open"
    )
    try:
        resp = requests.get(list_url, headers=headers, timeout=30)
        if resp.status_code != 200:
            yield {"type": "error", "content": f"Failed to list PRs: {resp.text[:200]}"}
            return

        prs = resp.json()
        if not prs:
            yield {"type": "error", "content": f"No open PR found for branch '{branch}'."}
            return

        pr_number = prs[0]["number"]
    except requests.RequestException as exc:
        yield {"type": "error", "content": f"Failed to fetch PR list: {exc}"}
        return

    # ── Merge the PR via squash ─────────────────────────────────────────
    merge_url = f"https://api.github.com/repos/{GITHUB_REPO}/pulls/{pr_number}/merge"
    try:
        merge_resp = requests.put(
            merge_url,
            json={"merge_method": "squash"},
            headers=headers,
            timeout=30,
        )
        if merge_resp.status_code == 200:
            yield {"type": "action", "content": "PR merged successfully via squash."}
            yield {"type": "deploy", "status": "triggered", "pr_number": pr_number}
        else:
            yield {
                "type": "error",
                "content": f"Merge failed ({merge_resp.status_code}): {merge_resp.text[:300]}",
            }
    except requests.RequestException as exc:
        yield {"type": "error", "content": f"Merge request failed: {exc}"}


def rollback_changes(push: bool = True) -> Generator[Dict[str, Any], None, None]:
    """Revert the last commit on the default branch.

    Checks out the default remote branch, pulls the latest changes, and
    reverts ``HEAD``.  If *push* is ``True``, the revert is also pushed
    to the remote.

    Parameters
    ----------
    push : bool, optional
        Whether to push the revert to the remote (default ``True``).

    Yields
    ------
    dict
        Events: ``thinking``, ``action``, ``done``, ``error``.
    """
    yield {"type": "thinking", "content": "Rolling back the last commit…"}

    try:
        repo, origin = get_repo()
    except Exception as exc:
        yield {"type": "error", "content": f"Could not open repository: {exc}"}
        return

    try:
        origin.fetch()
    except GitCommandError as exc:
        yield {"type": "error", "content": f"Fetch failed: {exc}"}
        return

    # Determine default branch from remote HEAD
    try:
        default_branch = repo.git.symbolic_ref("refs/remotes/origin/HEAD").split("/")[-1]
    except GitCommandError:
        default_branch = "main"

    try:
        repo.git.checkout(default_branch)
    except GitCommandError as exc:
        yield {"type": "error", "content": f"Checkout failed: {exc}"}
        return

    try:
        origin.pull()
    except GitCommandError:
        # Non-fatal — may not be needed
        pass

    # Stash local changes to prevent "overwritten by merge" errors
    stashed = False
    try:
        if repo.is_dirty(untracked_files=True):
            yield {"type": "thinking", "content": "📦 Stashing local changes before revert..."}
            repo.git.stash("push", "--include-untracked", "-m", "auto-stash-before-revert")
            stashed = True
    except GitCommandError:
        pass

    try:
        repo.git.revert("HEAD", no_edit=True, m=1)
        yield {"type": "action", "content": "Last commit reverted locally."}
    except GitCommandError as exc:
        yield {"type": "error", "content": f"Revert failed: {exc}"}
        return

    if stashed:
        try:
            repo.git.stash("pop")
        except GitCommandError:
            pass

    if push:
        try:
            repo_url = f"https://x-access-token:{GIT_TOKEN}@github.com/{GITHUB_REPO}.git"
            origin.set_url(repo_url)
            origin.push()
            yield {"type": "action", "content": "Revert pushed to remote."}
        except GitCommandError as exc:
            yield {"type": "error", "content": f"Push of revert failed: {exc}"}
            return

    yield {"type": "done", "content": "Rollback complete."}


def _git_commit_and_push(
    task: str,
    push: bool,
    branch_name: str,
) -> Generator[Dict[str, Any], None, None]:
    """Stage all changes, commit, and optionally push to a remote branch.

    Parameters
    ----------
    task : str
        The commit message (task description).
    push : bool
        Whether to push to remote.
    branch_name : str
        The branch name to push to.

    Yields
    ------
    dict
        Events: ``thinking``, ``action``, ``pr``, ``branch``.
    """
    try:
        repo, origin = get_repo()
    except Exception as exc:
        yield {"type": "error", "content": f"Could not open repository: {exc}"}
        return

    yield {"type": "thinking", "content": "Staging and committing changes…"}

    # ── Create or checkout branch ───────────────────────────────────────
    try:
        if branch_name in repo.heads:
            repo.delete_head(branch_name, force=True)
        repo.git.checkout("-b", branch_name)
    except GitCommandError as exc:
        yield {"type": "error", "content": f"Branch creation failed: {exc}"}
        return

    # ── Stage & commit ──────────────────────────────────────────────────
    try:
        repo.git.add(all=True)
        repo.index.commit(f"AI agent: {task}")
        yield {"type": "action", "content": f"Committed changes on branch '{branch_name}'."}
    except GitCommandError as exc:
        yield {"type": "error", "content": f"Commit failed: {exc}"}
        return

    if not push:
        yield {
            "type": "action",
            "content": f"Changes committed locally on branch '{branch_name}' (not pushed).",
        }
        yield {"type": "branch", "name": branch_name}
        return

    # ── Push ────────────────────────────────────────────────────────────
    try:
        repo_url = f"https://x-access-token:{GIT_TOKEN}@github.com/{GITHUB_REPO}.git"
        origin.set_url(repo_url)
        origin.push(branch_name)
        yield {"type": "action", "content": f"Pushed branch '{branch_name}' to remote."}
    except GitCommandError as exc:
        yield {"type": "error", "content": f"Push failed: {exc}"}
        return

    # ── Create PR ───────────────────────────────────────────────────────
    pr_url = create_pull_request(branch_name, task)
    if pr_url:
        yield {"type": "pr", "url": pr_url}
        yield {"type": "branch", "name": branch_name}
    else:
        yield {
            "type": "action",
            "content": "Branch pushed but PR creation failed (check token/permissions).",
        }
        yield {"type": "branch", "name": branch_name}


# ========================================================================
#  MAIN ORCHESTRATOR (Tool-Calling Loop)
# ========================================================================

def run_agent(
    user_input: str,
    model: str = DEFAULT_MODEL,
    deploy_enabled: bool = False,
) -> Generator[Dict[str, Any], None, None]:
    """Main orchestrator — tool-calling loop for the TalkCody system.

    This generator:
    1. Yields an initial ``thinking`` event.
    2. Sends the user message to DeepSeek with a system prompt and tools.
    3. Processes each tool call from DeepSeek, yielding events and
       returning results.
    4. Continues the loop until DeepSeek produces a final answer.
    5. Yields a final ``done`` event with total session cost.

    Parameters
    ----------
    user_input : str
        The raw text the user sent to the agent.
    model : str, optional
        The DeepSeek model identifier.  Defaults to :data:`DEFAULT_MODEL`.
    deploy_enabled : bool, optional
        If ``True``, automatically merge the PR after pushing (default
        ``False``).  This flag is passed through for compatibility but
        auto-deploy is now managed by the tool-calling agent.

    Yields
    ------
    dict
        SSE-style event dictionaries.  See module docstring for event types.

    Examples
    --------
    >>> for event in run_agent("Explore the project structure"):
    ...     if event["type"] == "done":
    ...         print(event.get("content", ""))
    """
    try:
        # ── 1. Initial thinking ─────────────────────────────────────────
        yield {"type": "thinking", "content": "🤔 Analyzing your request..."}

        # ── 2. Build the messages and tools ─────────────────────────────
        tools = _build_available_tools()

        system_prompt = _SYSTEM_PROMPT + "\n\n" + "\n".join(
            f"- **{t['function']['name']}**: {t['function']['description']}"
            for t in tools
        )

        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_input},
        ]

        # ── 3. Tool-calling loop ────────────────────────────────────────
        for iteration in range(_MAX_ITERATIONS):
            # ── 3a. Call DeepSeek ──────────────────────────────────────
            try:
                response = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=tools,
                    tool_choice="auto",
                    temperature=0.3,
                )
            except Exception as exc:
                yield {"type": "error", "content": f"DeepSeek API call failed: {exc}"}
                yield {"type": "done", "cost": get_session_cost()}
                return

            # ── 3b. Track cost ─────────────────────────────────────────
            usage = response.usage
            if usage:
                cost = calculate_cost(model, usage.prompt_tokens, usage.completion_tokens)
                add_cost(cost)

            # ── 3c. Extract the assistant message ──────────────────────
            assistant_message = response.choices[0].message

            # ── 3d. Handle tool calls ──────────────────────────────────
            if assistant_message.tool_calls:
                # Add assistant message to conversation
                messages.append({
                    "role": "assistant",
                    "content": assistant_message.content or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments,
                            },
                        }
                        for tc in assistant_message.tool_calls
                    ],
                })

                # Include reasoning if present - yield ONCE before processing tool calls
                reasoning = assistant_message.content or ""
                if reasoning:
                    yield {"type": "thinking", "content": reasoning}

                # Process each tool call
                for tool_call in assistant_message.tool_calls:
                    tool_name = tool_call.function.name
                    try:
                        tool_args = json.loads(tool_call.function.arguments)
                    except json.JSONDecodeError:
                        tool_args = {}

                    # Show what's happening
                    emoji = {
                        "read_file": "📖",
                        "write_file": "✍️",
                        "explore_project": "🔍",
                        "web_search": "🌐",
                        "read_todos": "📋",
                        "write_todo": "📋",
                        "git_commit": "✅",
                        "git_push": "🚀",
                        "create_pull_request": "📦",
                        "rollback_commit": "⏪",
                        "edit_file": "✍️",
                        "search_files": "🔍",
                        "review_files": "🔍",
                        "review_project": "🔍",
                        "generate_docs": "📝",
                        "generate_tests": "🧪",
                    }.get(tool_name, "🔧")

                    yield {
                        "type": "thinking",
                        "content": f"{emoji} Calling tool: **{tool_name}**",
                    }

                    # Execute the tool
                    tool_events, tool_result = _execute_tool(tool_name, tool_args)

                    # Yield all events from the tool execution (filter file content dumps)
                    for event in tool_events:
                        if event.get("type") == "file":
                            continue  # Don't dump file contents to UI
                        yield event

                    # Add tool result to conversation
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": tool_result,
                    })

                # Continue the loop to process the next DeepSeek response
                continue

            # ── 3e. No tool calls — final answer ───────────────────────
            content = assistant_message.content or ""
            if content:
                yield {"type": "thinking", "content": content}

            yield {"type": "done", "content": content, "cost": get_session_cost()}
            return

        # ── 4. Max iterations reached ────────────────────────────────────
        yield {
            "type": "error",
            "content": f"Maximum of {_MAX_ITERATIONS} tool calls reached. "
                        "The task may not be fully complete.",
        }
        yield {"type": "done", "cost": get_session_cost()}

    except Exception as exc:
        yield {
            "type": "error",
            "content": f"Unexpected error in orchestrator: {exc}",
        }
        import traceback
        traceback.print_exc()
        yield {"type": "done", "cost": get_session_cost()}


# ========================================================================
#  COMPATIBILITY ALIASES
# ========================================================================

def run_agent_stream(
    user_input: str,
    model_name: str = DEFAULT_MODEL,
    deploy_enabled: bool = False,
) -> Generator[Dict[str, Any], None, None]:
    """Alias for :func:`run_agent` — provides backward compatibility with
    server code that imports ``run_agent_stream`` from the old agent module.

    Parameters
    ----------
    user_input : str
        The raw text the user sent to the agent.
    model_name : str, optional
        The DeepSeek model identifier.  Defaults to :data:`DEFAULT_MODEL`.
    deploy_enabled : bool, optional
        Whether to auto-deploy after push (default ``False``).

    Yields
    ------
    dict
        The same events as :func:`run_agent`.
    """
    yield from run_agent(user_input, model=model_name, deploy_enabled=deploy_enabled)


# ========================================================================
#  CLI ENTRY POINT
# ========================================================================

if __name__ == "__main__":
    def _print_event(event: Dict[str, Any]) -> None:
        """Pretty-print a single event to the console."""
        etype = event.get("type", "unknown")

        if etype == "thinking":
            print(f"🧠 {event['content']}")
        elif etype == "action":
            print(f"⚡ {event['content']}")
        elif etype == "code":
            file_path = event.get("file", "?")
            preview = event.get("content", "")
            print(f"📄 {file_path}")
            if preview:
                print(f"   └─ {preview[:80]}{'…' if len(preview) > 80 else ''}")
        elif etype == "plan":
            print(f"📋 Plan: {event.get('summary', '')[:120]}")
            steps = event.get("steps", [])
            if steps:
                print(f"   └─ {len(steps)} step(s)")
        elif etype == "review":
            print(f"🔍 Review: {event.get('file', '?')} — "
                  f"Score: {event.get('score', '?')}/100, "
                  f"Issues: {len(event.get('issues', []))}")
        elif etype == "document":
            print(f"📝 Doc: {event.get('title', 'Untitled')}")
        elif etype == "question":
            print(f"❓ {event['content']}")
        elif etype == "pr":
            print(f"🔗 PR URL: {event['url']}")
        elif etype == "branch":
            print(f"🌿 Branch: {event['name']}")
        elif etype == "deploy":
            print(f"🚀 Deploy triggered (PR #{event.get('pr_number', '?')})")
        elif etype == "memory":
            print(f"💾 Memory ({event.get('operation', '?')}): {event.get('content', '')[:120]}")
        elif etype == "todo":
            print(f"📋 Todo ({event.get('operation', '?')}): {event.get('content', '')[:120]}")
        elif etype == "search_results":
            results = event.get("results", [])
            print(f"🔍 Search results for '{event.get('query', '')}': {len(results)} result(s)")
        elif etype == "file":
            print(f"📄 {event.get('path', '?')} ({len(event.get('content', ''))} chars)")
        elif etype == "file_listing":
            print(f"📂 Project files: {event.get('total', 0)} file(s)")
        elif etype == "done":
            msg = event.get("message") or event.get("content", "")
            cost = event.get("cost", 0.0)
            if msg:
                print(f"✅ {msg}")
            if cost:
                print(f"💰 Total session cost: ${cost:.6f}")
        elif etype == "error":
            print(f"❌ {event['content']}")
        else:
            print(f"[{etype}] {event.get('content', json.dumps(event))}")

    user_cmd = sys.argv[1] if len(sys.argv) > 1 else input("🤖 What should I do? ").strip()
    model_arg = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_MODEL
    deploy_arg = "--deploy" in sys.argv or "-d" in sys.argv

    for event in run_agent(user_cmd, model=model_arg, deploy_enabled=deploy_arg):
        _print_event(event)
