"""
Memory System for TalkCody Agent.

Provides persistent memory storage using a directory-based markdown file system.
Manages index files (MEMORY.md) and topic files organized by scope (project/global).

Directory structure:
    memory/
    ├── MEMORY.md              # Root index
    ├── project/
    │   ├── MEMORY.md          # Project-specific index
    │   └── topics/            # Project topic files
    └── global/
        ├── MEMORY.md          # Global index
        └── topics/            # Global topic files
"""

from pathlib import Path
from typing import Literal, Optional, Union

MEMORY_DIR: Path = Path("C:/Projects/talk/memory")

Scope = Literal["project", "global"]
Target = Literal["index", "topic", "topics"]
WriteMode = Literal["append", "replace"]


def _ensure_directories() -> None:
    """Create the memory directory structure if it doesn't exist.

    Creates all required directories under MEMORY_DIR on first use.
    Safe to call multiple times — existing directories are left untouched.
    """
    directories = [
        MEMORY_DIR,
        MEMORY_DIR / "project",
        MEMORY_DIR / "project" / "topics",
        MEMORY_DIR / "global",
        MEMORY_DIR / "global" / "topics",
    ]
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)

    # Ensure root MEMORY.md exists
    root_index = MEMORY_DIR / "MEMORY.md"
    if not root_index.exists():
        root_index.write_text("# Memory Index\n\n", encoding="utf-8")

    # Ensure project MEMORY.md exists
    project_index = MEMORY_DIR / "project" / "MEMORY.md"
    if not project_index.exists():
        project_index.write_text("# Project Memory\n\n", encoding="utf-8")

    # Ensure global MEMORY.md exists
    global_index = MEMORY_DIR / "global" / "MEMORY.md"
    if not global_index.exists():
        global_index.write_text("# Global Memory\n\n", encoding="utf-8")


def _scope_path(scope: Scope) -> Path:
    """Get the base path for the given scope.

    Args:
        scope: The memory scope — either "project" or "global".

    Returns:
        Path object pointing to the scope's directory under MEMORY_DIR.
    """
    return MEMORY_DIR / scope


def _resolve_target_path(
    target: Target,
    scope: Scope,
    file_name: Optional[str] = None,
) -> Path:
    """Resolve the full file path for a given target, scope, and file name.

    Args:
        target: The type of memory target ("index", "topic", or "topics").
        scope: The memory scope ("project" or "global").
        file_name: The topic file name (required when target is "topic").

    Returns:
        Path object for the resolved file or directory.

    Raises:
        ValueError: If target is "topic" but file_name is not provided.
    """
    base = _scope_path(scope)

    if target == "index":
        return base / "MEMORY.md"
    elif target == "topic":
        if not file_name:
            raise ValueError("file_name is required when target='topic'")
        # Ensure the topic has a .md extension for consistency
        name = file_name if file_name.endswith(".md") else f"{file_name}.md"
        return base / "topics" / name
    else:  # target == "topics"
        return base / "topics"


def memory_read(
    target: Target = "index",
    scope: Scope = "project",
    file_name: Optional[str] = None,
) -> Union[str, list[str]]:
    """Read memory content from the memory store.

    Args:
        target: What to read — "index" for MEMORY.md, "topic" for a specific
            topic file, or "topics" to list all topic files.
        scope: The memory scope — "project" or "global". Defaults to "project".
        file_name: The topic file name (without or with .md extension).
            Required when target is "topic". Ignored for other targets.

    Returns:
        When target is "index" or "topic": the file contents as a string.
            Returns an empty string if the file does not exist.
        When target is "topics": a list of topic file names (sans extension).
            Returns an empty list if the topics directory is empty or missing.

    Examples:
        >>> memory_read()                          # Read project MEMORY.md
        >>> memory_read("topic", "project", "goals")  # Read project topic
        >>> memory_read("topics", "global")         # List global topics
    """
    _ensure_directories()

    try:
        path = _resolve_target_path(target, scope, file_name)

        if target == "topics":
            if not path.exists():
                return []
            return sorted(
                f.stem for f in path.iterdir() if f.is_file() and f.suffix == ".md"
            )

        # target == "index" or "topic"
        if not path.exists() or not path.is_file():
            return ""
        return path.read_text(encoding="utf-8")

    except Exception:
        return "" if target != "topics" else []


def memory_write(
    target: Target = "index",
    scope: Scope = "project",
    content: str = "",
    file_name: Optional[str] = None,
    mode: WriteMode = "append",
) -> bool:
    """Write content to the memory store.

    Args:
        target: What to write to — "index" for MEMORY.md, "topic" for a
            specific topic file.
        scope: The memory scope — "project" or "global". Defaults to "project".
        content: The text content to write.
        file_name: The topic file name (without or with .md extension).
            Required when target is "topic". Ignored for "index".
        mode: The write mode — "append" to add content at the end, or
            "replace" to overwrite the entire file. Defaults to "append".

    Returns:
        True if the write was successful, False otherwise.

    Examples:
        >>> memory_write(content="## New Entry\\n\\nSome content\\n")
        >>> memory_write("topic", "global", "## Ideas\\n", "brainstorm")
        >>> memory_write("index", "project", "# Replaced\\n", mode="replace")
    """
    _ensure_directories()

    try:
        path = _resolve_target_path(target, scope, file_name)

        if target == "topic":
            # Ensure parent directory exists
            path.parent.mkdir(parents=True, exist_ok=True)

        if mode == "replace":
            path.write_text(content, encoding="utf-8")
        else:  # append
            if path.exists():
                with open(path, "a", encoding="utf-8") as f:
                    f.write(content)
            else:
                path.write_text(content, encoding="utf-8")

        return True

    except Exception:
        return False
