"""
Orchestrator Agent — the central brain of the TalkCody system.

This module receives user input, classifies the intent using DeepSeek,
delegates to the appropriate sub-agent, and streams all results back
via a generator that yields SSE-style event dictionaries.

Architecture
------------
All sub-agents exist as separate modules in the project:

- ``explore_agent.py``    — explore_file, web_search, explore_project
- ``plan_agent.py``       — generate_plan
- ``coding_agent.py``     — implement_changes
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
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Tuple

# ── Third-Party ───────────────────────────────────────────────────────────────

from git import Repo, GitCommandError
import requests

# ─── Re-export from config ────────────────────────────────────────────────────
# These are imported by plan_agent.py via ``from agent import ...``
# so they MUST be available at module level in this file.

from config import (                                        # noqa: F401 – re-exported for plan_agent
    MODEL_PRICING,
    DEFAULT_MODEL,
    PROJECT_ROOT,
    GIT_TOKEN,
    GITHUB_REPO,
    REPO_NAME,
    client,
    calculate_cost,
    add_cost,
    get_session_cost,
    reset_session,
)

# ─── Sub-agent imports ────────────────────────────────────────────────────────

from plan_agent import generate_plan
from coding_agent import implement_changes
from explore_agent import explore_file, web_search, explore_project
from review_agent import review_changes
from document_agent import generate_docs
from test_agent import generate_tests
import memory as memory_module


# ========================================================================
#  1.  INTENT CLASSIFICATION
# ========================================================================

_INTENT_SYSTEM_PROMPT = """\
You are an intent classification assistant. Your job is to analyse a user's \
input and determine what they want to do.

Classify the intent into exactly one of these categories:

- "modify"    — The user wants to CHANGE existing code / files.
- "question"  — The user wants ANALYSIS, EXPLANATION, or UNDERSTANDING of code.
- "explore"   — The user wants to SEE or DISPLAY raw file contents (no analysis).
- "plan"      — The user wants a plan for a task BEFORE implementing it.
- "code"      — The user wants to WRITE NEW CODE (files) or implement something.
- "review"    — The user wants a code review of existing code or changes.
- "document"  — The user wants documentation generated.
- "test"      — The user wants unit tests written.
- "memory"    — The user wants to remember something, recall memory, or forget.
- "todo"      — The user wants to manage a todo list.
- "rollback"  — The user wants to undo or revert the last change.

CRITICAL — Distinguish "explore" vs "question" carefully:

**"explore"** — User wants to SEE / DISPLAY raw file contents (dump the file as-is).
  Keywords: show me, read this, display the contents of, open, view, list, what's in
  Examples:
  - "show me the file"          \u2192 explore
  - "read this file"            \u2192 explore
  - "display the contents of"   \u2192 explore
  - "open app.js"               \u2192 explore
  - "what is in this file"      \u2192 explore
  - "list the files in src"     \u2192 explore

**"question"** — User wants ANALYSIS, EXPLANATION, or UNDERSTANDING of code.
  Keywords: study, understand, explain, analyze, tell me about, how does, what does, why does
  Examples:
  - "study this file"           \u2192 question
  - "understand this code"      \u2192 question
  - "explain app.js"           \u2192 question
  - "analyze this"             \u2192 question
  - "tell me about app.js"     \u2192 question
  - "how does this work"       \u2192 question
  - "what does this function do" \u2192 question
  - "look at app.js and understand it thoroughly" \u2192 question
  - "review this code for me"  \u2192 question

**RULE:** If the user says "study", "understand", "explain", "analyze", or "tell me about" a file,
this is a **question** intent (they want analysis), NOT explore.
Only classify as "explore" if they explicitly want to SEE the raw content.

Also extract:
- "task" — A concise description of what the user wants (rewrite it clearly).
- "push" — Boolean, default true. Whether to push to remote after modifications.
- "files" — A list of file paths if the user mentions specific files, else [].

Return ONLY a JSON object with this schema:
{"intent": "...", "task": "...", "push": true/false, "files": [...]}
"""


def classify_intent(
    user_input: str,
    model: str = DEFAULT_MODEL,
) -> Dict[str, Any]:
    """Analyse *user_input* to determine the user's intent.

    Uses DeepSeek (with ``response_format="json_object"``) to classify the
    input into one of the supported intents and extract the task, push flag,
    and any mentioned file paths.

    Parameters
    ----------
    user_input : str
        The raw text the user sent to the agent.
    model : str, optional
        The DeepSeek model identifier.  Defaults to :data:`DEFAULT_MODEL`.

    Returns
    -------
    dict
        A dictionary with keys ``intent``, ``task``, ``push``, and ``files``.
        On failure (API call or parse error) returns a fallback dict with
        intent ``"question"`` and the original input as the task.
    """
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _INTENT_SYSTEM_PROMPT},
                {"role": "user", "content": user_input},
            ],
            temperature=0.0,
            response_format={"type": "json_object"},
        )

        # ── Track cost ───────────────────────────────────────────────────
        usage = response.usage
        if usage:
            cost = calculate_cost(model, usage.prompt_tokens, usage.completion_tokens)
            add_cost(cost)

        raw = response.choices[0].message.content
        if raw:
            data = json.loads(raw)
            intent = str(data.get("intent", "question")).lower().strip()
            task = str(data.get("task", user_input))
            push = bool(data.get("push", True))
            files = list(data.get("files", []))
            return {"intent": intent, "task": task, "push": push, "files": files}

    except Exception as exc:
        # Log but don't crash — fall through to the default
        print(f"[agent] classify_intent error: {exc}")

    # Safe fallback
    return {"intent": "question", "task": user_input, "push": True, "files": []}


# ========================================================================
#  2.  GIT / GITHUB HELPERS
# ========================================================================

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


def create_pull_request(branch: str, title: str) -> str:
    """Create a pull request on GitHub via the REST API.

    Parameters
    ----------
    branch : str
        The head branch name (e.g. ``"agent/add-dark-mode"``).
    title : str
        The PR title (will be prefixed with ``"AI agent: "``).

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

    try:
        repo.git.revert("HEAD", no_edit=True)
        yield {"type": "action", "content": "Last commit reverted locally."}
    except GitCommandError as exc:
        yield {"type": "error", "content": f"Revert failed: {exc}"}
        return

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


# ========================================================================
#  3.  QUESTION ANSWERING
# ========================================================================

def _walk_project_files(root_path: Path) -> List[str]:
    """Walk *root_path* and return relative paths of all text files,
    skipping ignored directories and binary extensions.

    Parameters
    ----------
    root_path : Path
        The absolute project root directory.

    Returns
    -------
    list of str
        Relative file paths (e.g. ``"src/main.py"``) sorted alphabetically.
    """
    IGNORE_DIRS = {
        ".git", "__pycache__", "venv", ".venv", "node_modules",
        ".idea", ".vscode", "dist", "build", ".egg-info",
        ".tox", ".mypy_cache", ".pytest_cache", ".coding_agent_backups",
    }
    TEXT_EXTENSIONS = {
        ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".scss",
        ".json", ".md", ".yml", ".yaml", ".txt", ".toml", ".ini", ".cfg",
        ".env", ".gitignore", ".sql", ".sh", ".bat", ".xml", ".vue",
        ".rb", ".php", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
    }

    files: List[str] = []
    for f in root_path.rglob("*"):
        try:
            rel = f.relative_to(root_path)
        except ValueError:
            continue
        if any(part in IGNORE_DIRS for part in rel.parts):
            continue
        if f.is_file() and f.suffix.lower() in TEXT_EXTENSIONS:
            files.append(str(rel))

    files.sort(key=lambda x: x.lower())
    return files


def answer_question(
    user_input: str,
    model: str = DEFAULT_MODEL,
) -> Generator[Dict[str, Any], None, None]:
    """Answer a question about the codebase by intelligently selecting
    relevant files.

    Instead of reading a fixed set of files in priority order, this function:

    1. Walks the project to get a list of all file paths (no contents yet).
    2. Asks DeepSeek to identify which files are most relevant to the
       user's question (sending only the file list + question).
    3. Reads the contents of only those selected files.
    4. Streams the final answer back, token by token.

    Parameters
    ----------
    user_input : str
        The user's question (e.g. *"How does the auth module work?"*).
    model : str, optional
        The DeepSeek model identifier.  Defaults to :data:`DEFAULT_MODEL`.

    Yields
    ------
    dict
        Events: ``thinking``, ``done`` (with answer in ``message`` and
        accumulated cost in ``cost``), ``error``.
    """
    # ── Constants ────────────────────────────────────────────────────────
    max_files_to_select = 10
    per_file_chars = 12_000

    # ── Step 1: Scanning ────────────────────────────────────────────────
    yield {"type": "thinking", "content": "Scanning project files…"}

    root_path = Path(PROJECT_ROOT).resolve()
    all_files = _walk_project_files(root_path)

    if not all_files:
        yield {"type": "error", "content": "No project files found to analyse."}
        return

    # ── Step 2: Ask DeepSeek which files are relevant ───────────────────
    yield {"type": "thinking", "content": "Identifying relevant files…"}

    file_list_str = "\n".join(all_files)
    selection_system = (
        "You are a codebase navigation assistant. Given a list of project files "
        "and a user's question, identify which files are most relevant. "
        "Return a JSON object with two keys: 'files' (a list of exact file paths "
        f"from the list, up to {max_files_to_select}) and 'reasoning' "
        "(a short explanation of why those files were selected). "
        "Only include file paths that actually appear in the provided list."
    )
    selection_prompt = (
        f"User question: {user_input}\n\n"
        f"Project files:\n{file_list_str}\n\n"
        f"Which of these files are most relevant to answer the user's question? "
        f"Return your answer as JSON."
    )

    selection_messages = [
        {"role": "system", "content": selection_system},
        {"role": "user", "content": selection_prompt},
    ]

    try:
        selection_response = client.chat.completions.create(
            model=model,
            messages=selection_messages,
            temperature=0.0,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        yield {"type": "error", "content": f"File selection API call failed: {exc}"}
        return

    # ── Track selection cost ────────────────────────────────────────────
    usage = selection_response.usage
    if usage:
        sel_cost = calculate_cost(model, usage.prompt_tokens, usage.completion_tokens)
        add_cost(sel_cost)

    # ── Parse selected files from response ──────────────────────────────
    selected_files: List[str] = []
    raw = selection_response.choices[0].message.content
    if raw:
        try:
            data = json.loads(raw)
            selected_files = [
                p for p in data.get("files", [])[:max_files_to_select]
                if isinstance(p, str) and p in all_files
            ]
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    # If DeepSeek didn't select anything valid, fall back to a small safe set
    if not selected_files:
        # Pick the first few files as a minimal fallback
        selected_files = all_files[:min(3, len(all_files))]

    yield {
        "type": "thinking",
        "content": f"Reading {len(selected_files)} file(s)…",
    }

    # ── Step 3: Read selected files ─────────────────────────────────────
    code_context: List[str] = []
    total_chars = 0

    for rel_path in selected_files:
        abs_path = root_path / rel_path
        try:
            content = abs_path.read_text(encoding="utf-8", errors="replace")
        except (OSError, PermissionError):
            continue
        if len(content) > per_file_chars:
            content = content[:per_file_chars] + "\n# … (truncated)"
        code_context.append(f"--- {rel_path} ---\n{content}")
        total_chars += len(content)

    context_text = "\n\n".join(code_context)

    # ── Step 4: Answer with context, streamed ──────────────────────────
    system_msg = (
        "You are a helpful codebase assistant. Answer the user's question "
        "about the codebase concisely using Markdown. Reference specific "
        "file names, function names, and code snippets where relevant."
    )
    messages = [
        {"role": "system", "content": system_msg},
        {
            "role": "user",
            "content": (
                f"## Codebase Context\n\n{context_text}\n\n"
                f"## Question\n\n{user_input}"
            ),
        },
    ]

    try:
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.3,
            stream=True,
        )
    except Exception as exc:
        yield {"type": "error", "content": f"DeepSeek API call failed: {exc}"}
        return

    full_answer_parts: List[str] = []
    for chunk in response:
        if chunk.choices and len(chunk.choices) > 0:
            delta = chunk.choices[0].delta
            if delta and delta.content:
                token = delta.content
                full_answer_parts.append(token)
                yield {"type": "thinking", "content": token}

    answer = "".join(full_answer_parts)

    # ── Track answer cost ───────────────────────────────────────────────
    # Usage may be available on the final streaming chunk or the response
    answer_usage = getattr(response, "usage", None)
    if answer_usage:
        answer_cost = calculate_cost(
            model, answer_usage.prompt_tokens, answer_usage.completion_tokens
        )
        add_cost(answer_cost)

    yield {"type": "done", "message": answer, "cost": get_session_cost()}


# ========================================================================
#  4.  MEMORY & TODO HANDLERS
# ========================================================================

def handle_memory_operation(
    user_input: str,
) -> Generator[Dict[str, Any], None, None]:
    """Handle memory and todo operations.

    Recognised patterns:

    - ``"remember X"`` / ``"remember that X"`` — Write to memory.
    - ``"what do you remember?"`` / ``"recall"`` — Read from memory.
    - ``"forget everything"`` / ``"clear memory"`` — Reset memory.

    Parameters
    ----------
    user_input : str
        The user's raw input string.

    Yields
    ------
    dict
        Events: ``memory`` with operation results, ``done``, ``error``.
    """
    lower = user_input.strip().lower()

    # ── Write to memory ─────────────────────────────────────────────────
    if lower.startswith("remember") or lower.startswith("remember that"):
        # Extract the content after "remember" / "remember that"
        content = user_input
        for prefix in ("remember that ", "remember "):
            if content.lower().startswith(prefix):
                content = content[len(prefix):].strip()
                break
        if not content:
            yield {"type": "error", "content": "What should I remember?"}
            return

        success = memory_module.memory_write(
            target="index",
            scope="project",
            content=f"- {content}\n",
            mode="append",
        )
        if success:
            yield {
                "type": "memory",
                "operation": "write",
                "content": f"Remembered: {content}",
            }
            yield {"type": "done", "content": f"✅ I'll remember that: *{content}*"}
        else:
            yield {"type": "error", "content": "Failed to write to memory."}
        return

    # ── Read from memory ────────────────────────────────────────────────
    if any(phrase in lower for phrase in ("what do you remember", "recall", "what memory")):
        stored = memory_module.memory_read(target="index", scope="project")
        if stored and stored.strip():
            yield {
                "type": "memory",
                "operation": "read",
                "content": stored,
            }
            yield {"type": "done", "content": f"Here's what I remember:\n\n{stored}"}
        else:
            yield {
                "type": "memory",
                "operation": "read",
                "content": "",
            }
            yield {"type": "done", "content": "I don't have any stored memories yet."}
        return

    # ── Clear / forget ──────────────────────────────────────────────────
    if any(phrase in lower for phrase in ("forget everything", "clear memory", "reset memory")):
        success = memory_module.memory_write(
            target="index",
            scope="project",
            content="# Project Memory\n\n",
            mode="replace",
        )
        if success:
            yield {"type": "memory", "operation": "clear", "content": "Memory cleared."}
            yield {"type": "done", "content": "🧹 Memory cleared. I've forgotten everything."}
        else:
            yield {"type": "error", "content": "Failed to clear memory."}
        return

    # ── Default: show current memory state ──────────────────────────────
    stored = memory_module.memory_read(target="index", scope="project")
    if stored and stored.strip():
        yield {
            "type": "memory",
            "operation": "read",
            "content": stored,
        }
        yield {"type": "done", "content": f"Here's what I remember:\n\n{stored}"}
    else:
        yield {"type": "done", "content": "I don't have any stored memories yet."}


def handle_todo_operation(
    user_input: str,
) -> Generator[Dict[str, Any], None, None]:
    """Handle todo list operations.

    Simple todo management using the memory system as backend storage.
    Patterns:

    - ``"add todo X"`` / ``"todo: X"`` — Add a todo.
    - ``"show todos"`` / ``"list todos"`` — Show all todos.
    - ``"clear todos"`` / ``"done all"`` — Clear all todos.

    Parameters
    ----------
    user_input : str
        The user's raw input string.

    Yields
    ------
    dict
        Events: ``todo`` with operation results, ``done``, ``error``.
    """
    lower = user_input.strip().lower()

    # ── Add todo ────────────────────────────────────────────────────────
    if any(phrase in lower for phrase in ("add todo", "todo:", "new todo", "create todo")):
        content = user_input
        for prefix in ("add todo ", "todo: ", "new todo: ", "new todo ", "create todo "):
            idx = content.lower().find(prefix)
            if idx >= 0:
                content = content[idx + len(prefix):].strip()
                break
        if not content:
            yield {"type": "error", "content": "What should I add to the todo list?"}
            return

        success = memory_module.memory_write(
            target="topic",
            scope="project",
            content=f"- [ ] {content}\n",
            file_name="todos",
            mode="append",
        )
        if success:
            yield {
                "type": "todo",
                "operation": "add",
                "content": content,
            }
            yield {"type": "done", "content": f"✅ Added todo: *{content}*"}
        else:
            yield {"type": "error", "content": "Failed to add todo."}
        return

    # ── List todos ──────────────────────────────────────────────────────
    if any(phrase in lower for phrase in ("show todos", "list todos", "my todos", "what todos")):
        todos = memory_module.memory_read(target="topic", scope="project", file_name="todos")
        if todos and todos.strip():
            yield {
                "type": "todo",
                "operation": "list",
                "content": todos,
            }
            yield {"type": "done", "content": f"**My Todos:**\n\n{todos}"}
        else:
            yield {"type": "done", "content": "No todos yet. Add one with *remember to X* or *add todo X*."}
        return

    # ── Clear todos ─────────────────────────────────────────────────────
    if any(phrase in lower for phrase in ("clear todos", "done all", "remove all todos", "reset todos")):
        success = memory_module.memory_write(
            target="topic",
            scope="project",
            content="",
            file_name="todos",
            mode="replace",
        )
        if success:
            yield {"type": "todo", "operation": "clear", "content": "Todos cleared."}
            yield {"type": "done", "content": "🧹 All todos cleared."}
        else:
            yield {"type": "error", "content": "Failed to clear todos."}
        return

    # ── Fallback ────────────────────────────────────────────────────────
    yield {"type": "done", "content": "Todo command not recognised. Try: *add todo X*, *show todos*, or *clear todos*."}


# ========================================================================
#  5.  EXPLORE DELEGATION
# ========================================================================

def handle_explore_intent(
    user_input: str,
    files: List[str],
    model: str = DEFAULT_MODEL,
) -> Generator[Dict[str, Any], None, None]:
    """Delegate to the explore agent based on the user's input.

    Determines whether the user wants to:
    - Read a specific file (if files are mentioned)
    - Search the web (if input looks like a search query)
    - Explore the full project structure (default)

    Parameters
    ----------
    user_input : str
        The user's raw input.
    files : list of str
        File paths extracted during intent classification.
    model : str
        The DeepSeek model identifier.

    Yields
    ------
    dict
        Events from the chosen explore_agent function.
    """
    lower = user_input.lower()

    # ── If specific files were mentioned, read them ─────────────────────
    if files:
        for file_path in files:
            yield from explore_file(file_path, model=model)
        return

    # ── If it looks like a web search query ─────────────────────────────
    search_keywords = ("search for ", "search ", "look up ", "find online ", "web search ")
    if any(keyword in lower for keyword in search_keywords):
        # Extract query after the keyword
        query = user_input
        for keyword in search_keywords:
            idx = query.lower().find(keyword)
            if idx >= 0:
                query = query[idx + len(keyword):].strip()
                break
        yield from web_search(query, model=model)
        return

    # ── Read a specific file by name ────────────────────────────────────
    # Check if user mentions "read X", "show X", "open X", "file X"
    read_keywords = ("read ", "show ", "open ", "view ", "cat ", "file ")
    for keyword in read_keywords:
        if keyword in lower:
            idx = lower.find(keyword)
            file_candidate = user_input[idx + len(keyword):].strip().split()[0] if user_input[idx + len(keyword):].strip() else ""
            if file_candidate:
                yield from explore_file(file_candidate, model=model)
                return

    # ── Default: explore the full project ───────────────────────────────
    yield from explore_project(model=model)


# ========================================================================
#  6.  BUILD FILES CONTEXT (for plan / documentation / test)
# ========================================================================

def _build_files_context(task: str, model: str = DEFAULT_MODEL) -> str:
    """Build a text representation of the project's files for use as
    context in plan, documentation, or test generation.

    Walks the project tree and reads important files, then formats them
    as a string.

    Parameters
    ----------
    task : str
        The task description (used for the thinking event).
    model : str
        The DeepSeek model identifier (passed through).

    Returns
    -------
    str
        A formatted string containing file paths and contents.
    """
    IGNORE_DIRS = {
        ".git", "__pycache__", "venv", ".venv", "node_modules",
        ".idea", ".vscode", "dist", "build", ".egg-info",
        ".tox", ".mypy_cache", ".pytest_cache", ".coding_agent_backups",
    }
    TEXT_EXTENSIONS = {
        ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".scss",
        ".json", ".md", ".yml", ".yaml", ".txt", ".toml", ".ini",
    }
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
        if any(part in IGNORE_DIRS for part in rel.parts):
            continue
        if f.is_file() and f.suffix.lower() in TEXT_EXTENSIONS:
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
#  7.  GIT COMMIT / PUSH HELPERS (for modify/code intent)
# ========================================================================

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
#  8.  MAIN ORCHESTRATOR
# ========================================================================

def run_agent(
    user_input: str,
    model: str = DEFAULT_MODEL,
    auto_deploy: bool = False,
) -> Generator[Dict[str, Any], None, None]:
    """Main orchestrator — the central entry point for the TalkCody system.

    This generator:
    1. Yields a ``thinking`` event to show activity.
    2. Classifies the user's intent via :func:`classify_intent`.
    3. Delegates to the appropriate sub-agent.
    4. For ``modify`` / ``code`` intents, additionally performs Git commit,
       push, PR creation, and optional auto-deploy.
    5. Passes through all events from sub-agents.
    6. Yields a final ``done`` event with total session cost.

    Parameters
    ----------
    user_input : str
        The raw text the user sent to the agent.
    model : str, optional
        The DeepSeek model identifier.  Defaults to :data:`DEFAULT_MODEL`.
    auto_deploy : bool, optional
        If ``True``, automatically merge the PR after pushing (default
        ``False``).

    Yields
    ------
    dict
        SSE-style event dictionaries.  See module docstring for event types.

    Examples
    --------
    >>> for event in run_agent("What does the config module do?"):
    ...     if event["type"] == "done":
    ...         print(event.get("message", event["content"]))
    """
    try:
        # ── 1. Initial thinking ─────────────────────────────────────────
        yield {"type": "thinking", "content": "Analysing your request…"}

        # ── 2. Classify intent ──────────────────────────────────────────
        intent_data = classify_intent(user_input, model=model)
        intent = intent_data.get("intent", "question")
        task = intent_data.get("task", user_input)
        push = intent_data.get("push", True)
        files = intent_data.get("files", [])

        yield {
            "type": "thinking",
            "content": f"Intent: **{intent}** — {task[:100]}{'…' if len(task) > 100 else ''}",
        }

        # ── 3. Route to the appropriate sub-agent ───────────────────────

        if intent == "question":
            # ── Answer question about the codebase ──────────────────────
            yield from answer_question(user_input, model=model)

        elif intent == "explore":
            # ── Explore files / project / web ───────────────────────────
            yield from handle_explore_intent(user_input, files, model=model)

        elif intent == "plan":
            # ── Generate a plan ─────────────────────────────────────────
            yield {"type": "thinking", "content": "Building project context for planning…"}
            files_context = _build_files_context(task, model=model)
            yield from generate_plan(task, files_context, model=model)

        elif intent in ("code", "modify"):
            # ── Implement code changes ──────────────────────────────────
            yield {"type": "thinking", "content": "Building project context for implementation…"}
            files_context = _build_files_context(task, model=model)

            # Use the files context as a basic plan description
            plan_text = (
                f"## Task\n\n{task}\n\n"
                f"## Files Context\n\n{files_context}\n\n"
                "Implement the changes described in the task. Modify the "
                "necessary files using the write_file tool."
            )

            # Track whether code was actually written
            code_written = False
            branch_name = _sanitise_branch_name(task)

            for event in implement_changes(task, plan_text, model=model):
                if event["type"] == "done":
                    code_written = True
                    yield event
                elif event["type"] == "error":
                    yield event
                    # Don't proceed to git operations if code failed
                    return
                else:
                    yield event

            if code_written:
                # ── Git commit, push, PR ────────────────────────────────
                yield from _git_commit_and_push(task, push, branch_name)

                # ── Auto-deploy ─────────────────────────────────────────
                if auto_deploy and push:
                    yield from auto_deploy(branch_name)

        elif intent == "review":
            # ── Review code ─────────────────────────────────────────────
            if files:
                yield from review_changes(files, task, model=model)
            else:
                # If no specific files, gather changed or all relevant files
                yield {"type": "thinking", "content": "No specific files provided for review. Exploring project…"}
                yield from review_changes(
                    [str(p.relative_to(PROJECT_ROOT))
                     for p in Path(PROJECT_ROOT).rglob("*.py")
                     if ".git" not in str(p) and "__pycache__" not in str(p)],
                    task,
                    model=model,
                )

        elif intent == "document":
            # ── Generate documentation ─────────────────────────────────
            yield {"type": "thinking", "content": "Building project context for documentation…"}
            files_context = _build_files_context(task, model=model)
            yield from generate_docs(task, files_context, model=model)

        elif intent == "test":
            # ── Generate tests ──────────────────────────────────────────
            yield {"type": "thinking", "content": "Building project context for test generation…"}
            files_context = _build_files_context(task, model=model)
            yield from generate_tests(task, files_context, model=model)

        elif intent == "memory":
            # ── Memory operations ───────────────────────────────────────
            yield from handle_memory_operation(user_input)

        elif intent == "todo":
            # ── Todo operations ─────────────────────────────────────────
            yield from handle_todo_operation(user_input)

        elif intent == "rollback":
            # ── Rollback last commit ────────────────────────────────────
            yield from rollback_changes(push=push)

        else:
            # ── Unknown intent — fall back to question answering ────────
            yield {
                "type": "thinking",
                "content": f"Unrecognised intent '{intent}'. Falling back to answering as a question…",
            }
            yield from answer_question(user_input, model=model)

    except Exception as exc:
        yield {
            "type": "error",
            "content": f"Unexpected error in orchestrator: {exc}",
        }
        import traceback
        traceback.print_exc()

    finally:
        # ── Always yield a final done event with cost ───────────────────
        yield {
            "type": "done",
            "cost": get_session_cost(),
        }


# ========================================================================
#  9.  COMPATIBILITY ALIAS
# ========================================================================

def run_agent_stream(
    user_input: str,
    model_name: str = DEFAULT_MODEL,
    auto_deploy: bool = False,
) -> Generator[Dict[str, Any], None, None]:
    """Alias for :func:`run_agent` — provides backward compatibility with
    server code that imports ``run_agent_stream`` from the old agent module.

    Parameters
    ----------
    user_input : str
        The raw text the user sent to the agent.
    model_name : str, optional
        The DeepSeek model identifier.  Defaults to :data:`DEFAULT_MODEL`.
    auto_deploy : bool, optional
        Whether to auto-deploy after push (default ``False``).

    Yields
    ------
    dict
        The same events as :func:`run_agent`.
    """
    yield from run_agent(user_input, model=model_name, auto_deploy=auto_deploy)


# ========================================================================
# 10.  CLI ENTRY POINT
# ========================================================================

if __name__ == "__main__":
    import sys

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
                print(f"   └─ {len(steps)} step(s), "
                      f"difficulty: {event.get('estimated_difficulty', '?')}")
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
            print(f"✅ {msg}" if msg else f"✅ Done (cost: ${cost:.6f})")
            if cost:
                print(f"💰 Total session cost: ${cost:.6f}")
        elif etype == "error":
            print(f"❌ {event['content']}")
        else:
            print(f"[{etype}] {event.get('content', json.dumps(event))}")

    user_cmd = sys.argv[1] if len(sys.argv) > 1 else input("🤖 What should I do? ").strip()
    model_arg = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_MODEL
    deploy_arg = "--deploy" in sys.argv or "-d" in sys.argv

    for event in run_agent(user_cmd, model=model_arg, auto_deploy=deploy_arg):
        _print_event(event)
