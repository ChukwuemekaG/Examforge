"""
Explore Agent - Information gathering sub-agent for TalkCody.

Provides generator functions that yield SSE-style events for:
- Reading local files from the project directory
- Searching the web using DuckDuckGo
- Exploring the project structure

Each generator yields dicts with "type" and other fields for streaming to clients.
"""

import json
import os
import pathlib
from typing import Generator, Dict, Any, List

from config import PROJECT_ROOT

# Directories to skip when exploring the project
IGNORE_DIRS = {
    ".git",
    "__pycache__",
    "venv",
    ".venv",
    "node_modules",
    ".idea",
    ".vscode",
    ".DS_Store",
    "dist",
    "build",
    ".egg-info",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
}

# Text file extensions to consider for reading
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
    ".cfg",
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
}

# Important files to prioritise when exploring a project
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
}


def _is_text_file(file_path: pathlib.Path) -> bool:
    """Check if a file has a text extension that we can read."""
    return file_path.suffix.lower() in TEXT_EXTENSIONS


def _get_project_files(root_dir: pathlib.Path) -> List[pathlib.Path]:
    """
    Recursively list all text files in the project directory,
    skipping ignored directories.
    """
    files = []
    for entry in root_dir.rglob("*"):
        # Skip ignored directories
        relative = entry.relative_to(root_dir)
        parts = relative.parts
        if any(part in IGNORE_DIRS for part in parts):
            continue
        if entry.is_file() and _is_text_file(entry):
            files.append(entry)
    return files


def explore_file(path: str, model: str = "deepseek-chat") -> Generator[Dict[str, Any], None, None]:
    """
    Read a single file and yield its contents.

    Args:
        path: Absolute or relative path to the file to read.
        model: The AI model identifier (included for consistency with other functions).

    Yields:
        {"type": "thinking", "content": "..."} - Progress updates
        {"type": "file", "path": "...", "content": "..."} - File contents
        {"type": "done", "content": "File read complete."}
        {"type": "error", "content": "..."} - On failure
    """
    try:
        yield {"type": "thinking", "content": f"📖 Reading file: {path}"}

        file_path = pathlib.Path(path)

        # If relative path, resolve against project root
        if not file_path.is_absolute():
            file_path = PROJECT_ROOT / file_path

        # Resolve to absolute, canonical path
        file_path = file_path.resolve()

        # Security check: ensure the resolved path is within the project root
        try:
            file_path.relative_to(PROJECT_ROOT.resolve())
        except ValueError:
            yield {
                "type": "error",
                "content": f"Access denied: path '{path}' is outside the project directory.",
            }
            return

        if not file_path.exists():
            yield {
                "type": "error",
                "content": f"File not found: {path}",
            }
            return

        if not file_path.is_file():
            yield {
                "type": "error",
                "content": f"Not a file: {path}",
            }
            return

        # Read the file with encoding fallbacks
        content = None
        encodings = ["utf-8", "latin-1", "cp1252"]
        for encoding in encodings:
            try:
                with open(file_path, "r", encoding=encoding) as f:
                    content = f.read()
                break
            except (UnicodeDecodeError, UnicodeError):
                continue

        if content is None:
            yield {
                "type": "error",
                "content": f"Could not decode file '{path}' with any supported encoding.",
            }
            return

        # Use relative path for the event
        try:
            display_path = str(file_path.relative_to(PROJECT_ROOT.resolve()))
        except ValueError:
            display_path = str(file_path)

        yield {
            "type": "file",
            "path": display_path,
            "content": content,
        }
        yield {"type": "done", "content": "File read complete."}

    except PermissionError:
        yield {
            "type": "error",
            "content": f"Permission denied: unable to read '{path}'.",
        }
    except OSError as e:
        yield {
            "type": "error",
            "content": f"OS error reading '{path}': {e}",
        }
    except Exception as e:
        yield {
            "type": "error",
            "content": f"Unexpected error reading '{path}': {e}",
        }


def explore_files(paths: list, model: str = "deepseek-chat") -> Generator[Dict[str, Any], None, None]:
    """
    Read multiple files and yield events for each.

    Args:
        paths: A list of file paths (absolute or relative) to read.
        model: The AI model identifier (included for consistency with other functions).

    Yields:
        {"type": "thinking", "content": "..."} - Progress updates
        {"type": "file", "path": "...", "content": "..."} - File contents
        {"type": "done", "content": "Read N files."}
        {"type": "error", "content": "..."} - On failure for individual files
    """
    if not paths:
        yield {"type": "error", "content": "No file paths provided."}
        return

    if not isinstance(paths, list):
        yield {"type": "error", "content": "Paths must be provided as a list."}
        return

    yield {
        "type": "thinking",
        "content": f"📖 Reading {len(paths)} file(s)...",
    }

    total_read = 0
    total_errors = 0

    for path in paths:
        # Collect events from explore_file for each path
        # We iterate through all events and re-yield them
        results = []
        for event in explore_file(path, model=model):
            results.append(event)

        for event in results:
            # Filter out top-level done events from individual reads;
            # we'll yield our own at the end.
            if event["type"] == "done" and event.get("content") == "File read complete.":
                total_read += 1
                continue
            if event["type"] == "error":
                total_errors += 1
            yield event

    summary_parts = []
    if total_read > 0:
        summary_parts.append(f"Read {total_read} file(s)")
    if total_errors > 0:
        summary_parts.append(f"{total_errors} error(s)")

    if summary_parts:
        yield {"type": "done", "content": ". ".join(summary_parts) + "."}
    else:
        yield {"type": "done", "content": "No files were read."}


def web_search(query: str, model: str = "deepseek-chat") -> Generator[Dict[str, Any], None, None]:
    """
    Search the web using DuckDuckGo and yield results.

    Uses the duckduckgo_search library which requires no API key.

    Args:
        query: The search query string.
        model: The AI model identifier (included for consistency with other functions).

    Yields:
        {"type": "thinking", "content": "Searching..."} - Progress updates
        {"type": "search_results", "query": "...", "results": [...]} - Search results
        {"type": "done", "content": "Search complete."}
        {"type": "error", "content": "..."} - On failure
    """
    if not query or not query.strip():
        yield {"type": "error", "content": "Search query cannot be empty."}
        return

    try:
        yield {"type": "thinking", "content": f"🔍 Searching for: {query}"}

        from duckduckgo_search import DDGS

        with DDGS() as ddgs:
            raw_results = list(ddgs.text(query, max_results=5))

        # Normalise results into a consistent format
        results = []
        for r in raw_results:
            results.append({
                "title": r.get("title", ""),
                "url": r.get("href", r.get("url", "")),
                "snippet": r.get("body", r.get("snippet", "")),
            })

        yield {
            "type": "search_results",
            "query": query,
            "results": results,
        }
        yield {"type": "done", "content": "Search complete."}

    except ImportError:
        yield {
            "type": "error",
            "content": (
                "The 'duckduckgo_search' library is not installed. "
                "Install it with: pip install duckduckgo_search"
            ),
        }
    except Exception as e:
        yield {
            "type": "error",
            "content": f"Search failed: {e}",
        }


def explore_project(model: str = "deepseek-chat") -> Generator[Dict[str, Any], None, None]:
    """
    Get an overview of the project by listing all files and reading important ones.

    Walks the project directory (excluding .git, __pycache__, venv, node_modules, etc.),
    lists all text files, and reads the most important ones for context.

    Args:
        model: The AI model identifier (included for consistency with other functions).

    Yields:
        {"type": "thinking", "content": "..."} - Progress updates
        {"type": "file_listing", "files": [...], "total": N} - List of all project files
        {"type": "file", "path": "...", "content": "..."} - Contents of important files
        {"type": "done", "content": "Project exploration complete. Found N files."}
        {"type": "error", "content": "..."} - On failure
    """
    try:
        yield {
            "type": "thinking",
            "content": "🔍 Exploring project structure...",
        }

        root = PROJECT_ROOT.resolve()

        if not root.exists():
            yield {
                "type": "error",
                "content": f"Project directory not found: {root}",
            }
            return

        if not root.is_dir():
            yield {
                "type": "error",
                "content": f"Project path is not a directory: {root}",
            }
            return

        # Gather all text files
        yield {"type": "thinking", "content": "📂 Listing project files..."}

        project_files = _get_project_files(root)

        # Sort: important files first, then alphabetical
        project_files.sort(
            key=lambda f: (
                0 if f.name in IMPORTANT_FILES else 1,
                str(f.relative_to(root)).lower(),
            )
        )

        # Build a list of relative paths for the file listing event
        file_list = []
        for f in project_files:
            try:
                rel_path = str(f.relative_to(root))
                file_list.append(rel_path)
            except ValueError:
                file_list.append(str(f))

        yield {
            "type": "file_listing",
            "files": file_list,
            "total": len(file_list),
        }

        yield {
            "type": "thinking",
            "content": f"📖 Found {len(file_list)} text file(s). Reading important files...",
        }

        # Read important files (limit to a reasonable number)
        important_read = []
        for f in project_files:
            if f.name in IMPORTANT_FILES:
                # Delegate to explore_file logic but capture only the file event
                for event in explore_file(str(f), model=model):
                    if event["type"] == "file":
                        important_read.append(event["path"])
                        yield event
                    elif event["type"] == "error":
                        yield event
                    # Skip thinking and done events from the sub-generator

        if important_read:
            yield {
                "type": "thinking",
                "content": f"✅ Read {len(important_read)} important file(s): {', '.join(important_read)}",
            }
        else:
            yield {"type": "thinking", "content": "ℹ️ No important files found to read."}

        yield {
            "type": "done",
            "content": f"Project exploration complete. Found {len(file_list)} file(s).",
        }

    except PermissionError as e:
        yield {
            "type": "error",
            "content": f"Permission denied while exploring project: {e}",
        }
    except OSError as e:
        yield {
            "type": "error",
            "content": f"OS error while exploring project: {e}",
        }
    except Exception as e:
        yield {
            "type": "error",
            "content": f"Unexpected error during project exploration: {e}",
        }


if __name__ == "__main__":
    """
    CLI entry point for testing the explore agent.
    
    Usage:
        python explore_agent.py file <path>
        python explore_agent.py files <path1> <path2> ...
        python explore_agent.py search <query>
        python explore_agent.py project
    """
    import sys

    if len(sys.argv) < 2:
        print("Usage:")
        print("  python explore_agent.py file <path>")
        print("  python explore_agent.py files <path1> <path2> ...")
        print("  python explore_agent.py search <query>")
        print("  python explore_agent.py project")
        sys.exit(1)

    command = sys.argv[1].lower()

    if command == "file" and len(sys.argv) >= 3:
        path = sys.argv[2]
        for event in explore_file(path):
            print(json.dumps(event, indent=2))

    elif command == "files" and len(sys.argv) >= 3:
        paths = sys.argv[2:]
        for event in explore_files(paths):
            print(json.dumps(event, indent=2))

    elif command == "search" and len(sys.argv) >= 3:
        query = " ".join(sys.argv[2:])
        for event in web_search(query):
            print(json.dumps(event, indent=2))

    elif command == "project":
        for event in explore_project():
            print(json.dumps(event, indent=2))

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)
