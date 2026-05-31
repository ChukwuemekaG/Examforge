"""
Code Review Agent module for the TalkCody project.

This agent reviews code changes and entire projects by sending file contents
to the DeepSeek API for analysis. It checks for bugs, security issues,
performance problems, code style violations, and missing error handling,
returning structured JSON review results with severity-graded issue lists
and overall quality scores.

Typical usage (SSE event stream)::

    from review_agent import review_changes, review_project

    for event in review_changes(["src/auth/login.py"], "Add login endpoint"):
        if event["type"] == "thinking":
            ...  # Stream to user
        elif event["type"] == "review":
            print(f"Score: {event['score']}, Issues: {len(event['issues'])}")
        elif event["type"] == "done":
            print("Review complete.")
        elif event["type"] == "error":
            print(f"Error: {event['content']}")
"""

import json
import os
import pathlib
from typing import Any, Dict, Generator, List, Optional, Tuple

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

REVIEW_SYSTEM_PROMPT = """\
You are an expert senior code reviewer. Your job is to analyze source code files \
and produce a detailed, actionable code review.

For each file, check for:
1. **Bugs or logic errors** — off-by-one errors, incorrect conditions, race conditions, etc.
2. **Security issues** — SQL injection, XSS, CSRF, insecure deserialization, hardcoded secrets, path traversal, etc.
3. **Performance problems** — unnecessary allocations, O(n²) where O(n) suffices, blocking I/O in hot paths, etc.
4. **Code style violations** — inconsistent naming, violations of PEP8 or project conventions, overly complex expressions, etc.
5. **Missing error handling** — unhandled exceptions, missing input validation, silent failures, etc.

Return your analysis **only** as a JSON object with the following exact schema:
{
    "score": 85,
    "issues": [
        {
            "severity": "high|medium|low",
            "line": 12,
            "description": "Clear description of the issue."
        }
    ],
    "summary": "A 1-3 sentence overall summary of the code quality."
}

Rules:
- The **score** must be an integer between 0 and 100, where 100 is perfect code.
- Each **issue** must have a severity of "high", "medium", or "low".
- The **line** field should be the approximate line number (use 1 if unknown or N/A).
- The **description** must be specific, actionable, and reference actual code patterns.
- If the file is clean with no issues, return an empty issues list and a score of 100.
- Do **not** include any text outside the JSON object.
""".strip()

DEFAULT_MODEL = "deepseek-chat"

# Directories and extensions to skip when reviewing a project
IGNORE_DIRS = {
    ".git",
    "__pycache__",
    "venv",
    ".venv",
    "node_modules",
    ".idea",
    ".vscode",
    "dist",
    "build",
    ".egg-info",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".coding_agent_backups",
}

TEXT_EXTENSIONS = {
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".html",
    ".css",
    ".scss",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".txt",
    ".toml",
    ".ini",
    ".cfg",
    ".env",
    ".gitignore",
    ".dockerfile",
    ".conf",
    ".sql",
    ".sh",
    ".bat",
    ".ps1",
    ".xml",
    ".svg",
    ".vue",
    ".svelte",
    ".rb",
    ".php",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".swift",
    ".kt",
    ".gradle",
    ".properties",
    ".tsx",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
}

IMPORTANT_FILES = {
    "index.html",
    "app.js",
    "main.js",
    "style.css",
    "app.html",
    "package.json",
    "README.md",
    "readme.md",
    "requirements.txt",
    "setup.py",
    "pyproject.toml",
    "composer.json",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Dockerfile",
    ".env.example",
    "tsconfig.json",
    "webpack.config.js",
    "vite.config.ts",
    "next.config.js",
    "vercel.json",
    "agent.py",
    "server.py",
    "config.py",
}


# ── Helper Functions ──────────────────────────────────────────────────────────

def _get_project_root() -> pathlib.Path:
    """Return the resolved project root directory.

    Uses ``PROJECT_ROOT`` from config if defined, otherwise falls back
    to the current working directory.
    """
    if PROJECT_ROOT:
        return pathlib.Path(PROJECT_ROOT).resolve()
    return pathlib.Path.cwd().resolve()


def _is_text_file(file_path: pathlib.Path) -> bool:
    """Check whether *file_path* has a recognised text-file extension."""
    return file_path.suffix.lower() in TEXT_EXTENSIONS


def _is_ignored(file_path: pathlib.Path, root: pathlib.Path) -> bool:
    """Check whether *file_path* lives inside an ignored directory."""
    try:
        relative = file_path.relative_to(root)
    except ValueError:
        return True  # outside the project root — treat as ignored
    return any(part in IGNORE_DIRS for part in relative.parts)


def _gather_project_files(root: pathlib.Path) -> List[pathlib.Path]:
    """Recursively gather all text files in the project, skipping ignored dirs.

    Args:
        root: The project root directory.

    Returns:
        A list of ``pathlib.Path`` objects for each text file.
    """
    files: List[pathlib.Path] = []
    if not root.is_dir():
        return files

    for entry in root.rglob("*"):
        if not entry.is_file():
            continue
        if _is_ignored(entry, root):
            continue
        if _is_text_file(entry):
            files.append(entry)

    # Sort: important files first, then alphabetical
    files.sort(
        key=lambda f: (
            0 if f.name in IMPORTANT_FILES else 1,
            str(f.relative_to(root)).lower(),
        ),
    )
    return files


def _read_file_content(file_path: pathlib.Path) -> Optional[str]:
    """Read a file's content with automatic encoding fallback.

    Args:
        file_path: The path to the file to read.

    Returns:
        The file content as a string, or ``None`` if the file could not be
        decoded with any supported encoding.
    """
    encodings = ["utf-8", "latin-1", "cp1252", "utf-16"]
    for encoding in encodings:
        try:
            with open(file_path, "r", encoding=encoding) as f:
                return f.read()
        except (UnicodeDecodeError, UnicodeError):
            continue
        except (OSError, PermissionError):
            return None
    return None


def _make_relative_path(file_path: pathlib.Path, root: pathlib.Path) -> str:
    """Return a relative path string for display purposes.

    Falls back to the absolute path if the file is outside the project root.
    """
    try:
        return str(file_path.relative_to(root))
    except ValueError:
        return str(file_path)


def _call_deepseek_review(
    file_content: str,
    file_path: str,
    task: str,
    model: str,
) -> Tuple[Optional[Dict[str, Any]], Optional[float], Optional[str]]:
    """Send a single file to DeepSeek for code review.

    Args:
        file_content: The full text content of the file.
        file_path: A human-readable file path (for the prompt context).
        task: The original user task (for context).
        model: The DeepSeek model name.

    Returns:
        A tuple of ``(parsed_json, cost, error_message)``. On success
        ``error_message`` is ``None``; on failure ``parsed_json`` and
        ``cost`` are ``None``.
    """
    user_prompt = (
        f"## Original Task\n\n{task}\n\n"
        f"## File Under Review\n\n`{file_path}`\n\n"
        f"## File Content\n\n```\n{file_content}\n```\n\n"
        "Please review this file thoroughly and return a JSON object "
        "with your findings."
    )

    messages = [
        {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    try:
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.1,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        return None, None, f"DeepSeek API call failed: {exc}"

    # ── Track cost ──────────────────────────────────────────────
    usage = response.usage
    cost = 0.0
    if usage:
        try:
            cost = calculate_cost(model, usage.prompt_tokens, usage.completion_tokens)
        except (KeyError, TypeError):
            pricing = MODEL_PRICING.get(model, MODEL_PRICING.get("deepseek-chat", {"input": 0.27, "output": 1.10}))
            input_cost = (usage.prompt_tokens / 1_000_000) * pricing["input"]
            output_cost = (usage.completion_tokens / 1_000_000) * pricing["output"]
            cost = input_cost + output_cost
        add_cost(cost)

    # ── Parse JSON response ─────────────────────────────────────
    raw_content = response.choices[0].message.content
    if not raw_content or not raw_content.strip():
        return None, cost, "Empty response from DeepSeek."

    try:
        parsed = json.loads(raw_content)
    except json.JSONDecodeError as exc:
        return None, cost, f"Failed to parse review JSON: {exc}. Raw: {raw_content[:200]}"

    # Validate the structure
    if not isinstance(parsed, dict):
        return None, cost, "Review response is not a JSON object."

    if "score" not in parsed:
        parsed["score"] = 100
    if "issues" not in parsed:
        parsed["issues"] = []
    if "summary" not in parsed:
        parsed["summary"] = "No summary provided."

    return parsed, cost, None


# ── Public Generators ─────────────────────────────────────────────────────────

def review_changes(
    files_changed: List[str],
    task: str,
    model: str = DEFAULT_MODEL,
) -> Generator[Dict[str, Any], None, None]:
    """Review a list of changed files using the DeepSeek API.

    This generator yields SSE-style event dictionaries for streaming to
    a client interface.

    Args:
        files_changed: A list of file paths (relative to the project root)
            that have been changed and need review.
        task: The original user task description, providing context for
            the review.
        model: The DeepSeek model to use (default ``"deepseek-chat"``).

    Yields:
        Event dictionaries:

        - ``{"type": "thinking", "content": "Reviewing file X..."}``
          — status update while analysing a file.
        - ``{"type": "review", "file": "path", "issues": [...],
            "score": 85, "summary": "...", "content": "..."}``
          — the review result for a single file.
        - ``{"type": "done", "content": "Review complete.",
            "total_issues": 0, "avg_score": 0, "cost": 0.0}``
          — emitted once when all files have been reviewed.
        - ``{"type": "error", "content": "..."}`` — emitted on failure.

    Raises:
        The generator catches most exceptions and yields an error event
        instead of propagating them.
    """
    # ── Validate inputs ──────────────────────────────────────────
    if not files_changed:
        yield {"type": "error", "content": "No files provided for review."}
        return

    if not isinstance(files_changed, list):
        yield {"type": "error", "content": "files_changed must be a list of file paths."}
        return

    if not task or not task.strip():
        yield {"type": "error", "content": "Task description cannot be empty."}
        return

    if model not in MODEL_PRICING and model != DEFAULT_MODEL:
        yield {
            "type": "error",
            "content": (
                f"Unknown model '{model}'. Supported models: "
                f"{', '.join(MODEL_PRICING.keys())}."
            ),
        }
        return

    project_root = _get_project_root()

    # ── Review each file ─────────────────────────────────────────
    total_issues = 0
    scores: List[int] = []
    total_cost = 0.0

    for file_path in files_changed:
        # Resolve the file path
        candidate = pathlib.Path(file_path)
        if not candidate.is_absolute():
            candidate = project_root / candidate
        candidate = candidate.resolve()

        # Security check: file must be inside the project root
        try:
            candidate.relative_to(project_root)
        except ValueError:
            yield {
                "type": "error",
                "content": f"Access denied: '{file_path}' is outside the project directory.",
            }
            continue

        # Check that the file exists
        if not candidate.exists():
            yield {
                "type": "error",
                "content": f"File not found: {file_path}",
            }
            continue

        if not candidate.is_file():
            yield {
                "type": "error",
                "content": f"Not a file: {file_path}",
            }
            continue

        display_path = _make_relative_path(candidate, project_root)
        yield {"type": "thinking", "content": f"🔍 Reviewing file {display_path}..."}

        # Read file content
        content = _read_file_content(candidate)
        if content is None:
            yield {
                "type": "error",
                "content": f"Could not read file: {file_path}",
            }
            continue

        # Call DeepSeek for review
        review_data, cost, error = _call_deepseek_review(
            file_content=content,
            file_path=display_path,
            task=task,
            model=model,
        )

        if error:
            yield {"type": "error", "content": f"Review failed for '{file_path}': {error}"}
            continue

        if cost is not None:
            total_cost += cost

        # Extract review fields with safe defaults
        score = review_data.get("score", 100)
        issues = review_data.get("issues", [])
        summary = review_data.get("summary", "")

        # Ensure score is an integer in range 0-100
        try:
            score = max(0, min(100, int(score)))
        except (ValueError, TypeError):
            score = 100

        # Sanitise issues list
        sanitised_issues = []
        valid_severities = {"high", "medium", "low"}
        for issue in issues:
            if not isinstance(issue, dict):
                continue
            severity = str(issue.get("severity", "low")).lower()
            if severity not in valid_severities:
                severity = "low"
            try:
                line = int(issue.get("line", 1))
            except (ValueError, TypeError):
                line = 1
            description = str(issue.get("description", "No description provided."))
            sanitised_issues.append({
                "severity": severity,
                "line": line,
                "description": description,
            })

        total_issues += len(sanitised_issues)
        scores.append(score)

        # Yield the review event
        yield {
            "type": "review",
            "file": display_path,
            "issues": sanitised_issues,
            "score": score,
            "summary": summary,
            "content": _format_review_text(display_path, score, sanitised_issues, summary),
        }

    # ── Compute aggregate stats ─────────────────────────────────
    avg_score = round(sum(scores) / len(scores), 1) if scores else 0

    yield {
        "type": "done",
        "content": "Review complete.",
        "total_issues": total_issues,
        "avg_score": avg_score,
        "cost": round(total_cost, 8),
    }


def review_project(
    task: str,
    model: str = DEFAULT_MODEL,
) -> Generator[Dict[str, Any], None, None]:
    """Review the entire project by discovering and analysing all source files.

    This is a convenience wrapper around :func:`review_changes` that first
    walks the project directory tree to collect all text files, then feeds
    them to the review pipeline.

    Args:
        task: The original user task or review focus, providing context.
        model: The DeepSeek model to use (default ``"deepseek-chat"``).

    Yields:
        The same event types as :func:`review_changes`, with an additional
        initial ``thinking`` event listing the discovered files.
    """
    # ── Validate inputs ──────────────────────────────────────────
    if not task or not task.strip():
        yield {"type": "error", "content": "Task description cannot be empty."}
        return

    if model not in MODEL_PRICING and model != DEFAULT_MODEL:
        yield {
            "type": "error",
            "content": (
                f"Unknown model '{model}'. Supported models: "
                f"{', '.join(MODEL_PRICING.keys())}."
            ),
        }
        return

    project_root = _get_project_root()

    if not project_root.exists():
        yield {
            "type": "error",
            "content": f"Project directory not found: {project_root}",
        }
        return

    if not project_root.is_dir():
        yield {
            "type": "error",
            "content": f"Project path is not a directory: {project_root}",
        }
        return

    # ── Discover project files ───────────────────────────────────
    yield {
        "type": "thinking",
        "content": f"🔍 Exploring project structure at {project_root}...",
    }

    try:
        project_files = _gather_project_files(project_root)
    except PermissionError as exc:
        yield {"type": "error", "content": f"Permission denied while exploring project: {exc}"}
        return
    except OSError as exc:
        yield {"type": "error", "content": f"OS error while exploring project: {exc}"}
        return

    if not project_files:
        yield {
            "type": "error",
            "content": "No text files found in the project to review.",
        }
        return

    # Build relative path list
    relative_paths = [_make_relative_path(f, project_root) for f in project_files]

    yield {
        "type": "thinking",
        "content": f"📂 Found {len(relative_paths)} file(s) to review.",
    }

    # ── Delegate to review_changes ───────────────────────────────
    # We iterate through review_changes and re-yield its events,
    # ensuring a consistent top-level done event with project-level stats.
    total_issues = 0
    total_cost = 0.0
    scores: List[int] = []

    for event in review_changes(relative_paths, task, model=model):
        if event["type"] == "done":
            # Capture the aggregate stats from the sub-generator
            total_issues = event.get("total_issues", 0)
            avg_score = event.get("avg_score", 0)
            total_cost = event.get("cost", 0.0)
            # Replace the sub-generator's done with our own
            yield {
                "type": "done",
                "content": f"Project review complete. Reviewed {len(relative_paths)} file(s).",
                "total_files": len(relative_paths),
                "total_issues": total_issues,
                "avg_score": avg_score,
                "cost": round(total_cost, 8),
            }
        elif event["type"] == "review":
            scores.append(event.get("score", 100))
            yield event
        else:
            yield event


# ── Internal Formatting ───────────────────────────────────────────────────────

def _format_review_text(
    file_path: str,
    score: int,
    issues: List[Dict[str, Any]],
    summary: str,
) -> str:
    """Build a human-readable Markdown string summarising a review result.

    Args:
        file_path: The path to the reviewed file.
        score: The quality score (0-100).
        issues: The list of issue dictionaries.
        summary: The review summary text.

    Returns:
        A Markdown-formatted review text.
    """
    lines: List[str] = [
        f"## 📄 Review: `{file_path}`",
        "",
        f"**Score:** {score}/100",
        "",
    ]

    if summary:
        lines.append(f"**Summary:** {summary}")
        lines.append("")

    if not issues:
        lines.append("✅ No issues found. Clean code!")
    else:
        # Count by severity
        severity_counts: Dict[str, int] = {"high": 0, "medium": 0, "low": 0}
        for issue in issues:
            sev = issue.get("severity", "low")
            if sev in severity_counts:
                severity_counts[sev] += 1

        lines.append(f"**Issues found:** {len(issues)} total "
                      f"(🔴 {severity_counts['high']} high, "
                      f"🟡 {severity_counts['medium']} medium, "
                      f"🟢 {severity_counts['low']} low)")
        lines.append("")

        for i, issue in enumerate(issues, start=1):
            severity = issue.get("severity", "low")
            line_num = issue.get("line", 1)
            description = issue.get("description", "No description.")

            severity_icon = {"high": "🔴", "medium": "🟡", "low": "🟢"}
            icon = severity_icon.get(severity, "🟢")

            lines.append(f"{i}. {icon} **[{severity.upper()}] Line {line_num}:** {description}")

    lines.append("")
    return "\n".join(lines)


# ── CLI Entry Point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    def _print_event(event: Dict[str, Any]) -> None:
        """Pretty-print a single event dict to the console."""
        etype = event.get("type", "unknown")
        if etype == "thinking":
            print(f"🧠 {event['content']}")
        elif etype == "review":
            print(f"📋 {event.get('file', '?')} — Score: {event.get('score', '?')}/100, "
                  f"Issues: {len(event.get('issues', []))}")
            # Print the formatted content
            content = event.get("content", "")
            if content:
                print(content)
        elif etype == "done":
            print(f"✅ {event['content']}")
            print(f"   Total issues: {event.get('total_issues', 0)}")
            print(f"   Average score: {event.get('avg_score', 0)}/100")
            print(f"   Cost: ${event.get('cost', 0.0):.6f}")
        elif etype == "error":
            print(f"❌ {event['content']}")

    # Determine mode from CLI args
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python review_agent.py changes <task> <file1> [file2 ...]")
        print("  python review_agent.py project <task>")
        print("  python review_agent.py changes <task> --from-session")
        sys.exit(1)

    command = sys.argv[1].lower()
    model_arg = os.environ.get("REVIEW_MODEL", DEFAULT_MODEL)

    if command == "changes" and len(sys.argv) >= 4:
        task_arg = sys.argv[2]
        file_args = sys.argv[3:]
        for event in review_changes(file_args, task_arg, model=model_arg):
            _print_event(event)

    elif command == "project" and len(sys.argv) >= 3:
        task_arg = sys.argv[2]
        for event in review_project(task_arg, model=model_arg):
            _print_event(event)

    else:
        print(f"Unknown command or insufficient arguments: {command}")
        print("Usage:")
        print("  python review_agent.py changes <task> <file1> [file2 ...]")
        print("  python review_agent.py project <task>")
        sys.exit(1)
