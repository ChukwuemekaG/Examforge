"""
Document Writer Agent module for the TalkCody project.

This agent generates comprehensive documentation for code and projects
using the DeepSeek API. It produces high-quality Markdown documentation
covering overview, installation, usage, API reference, and configuration.

Two main entry points are provided:

- :func:`generate_docs` — General-purpose documentation generator that
  accepts any documentation task description and file context.
- :func:`generate_readme` — Specialised generator that produces README.md
  content with a project overview, installation guide, usage examples, and
  configuration reference.

Both functions are **generators** that yield SSE-style event dictionaries
suitable for streaming to a client interface.

Typical usage::

    from document_agent import generate_docs, generate_readme

    # Generate docs for a specific feature
    for event in generate_docs(
        "Write API documentation for the auth module",
        files_context="...",
    ):
        if event["type"] == "document":
            print(event["title"])
            print(event["content"])
        elif event["type"] == "done":
            print(f"Cost: ${event['cost']:.6f}")

    # Generate a README
    for event in generate_readme(
        "A CLI tool for managing project tasks",
        files_context="...",
    ):
        if event["type"] == "document":
            readme_content = event["content"]
"""

import json
from typing import Any, Dict, Generator, Optional

# ── Shared dependencies from project config ──────────────────────────────────
# The config module re-exports the DeepSeek client, pricing data, cost-tracking
# helpers, and the project root path from the main agent module (agent.py).

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
"""Default DeepSeek model identifier used when no model is explicitly provided."""

_DOCS_SYSTEM_PROMPT = """\
You are an expert technical writer and software documentarian. Your job is to \
produce clear, comprehensive, and well-structured documentation for code and \
software projects.

You will be given:
1. A **task** describing what documentation is needed.
2. **Files context** — the actual source code or file context for the feature \
or project being documented.

Write the documentation in **Markdown** format, following these guidelines:

## Structure

Your documentation should include the following sections as appropriate:

1. **Overview / Purpose** — What does this code/project do? Why does it exist?
   Describe the problem it solves and its core value proposition.

2. **Installation** — How to install or set up the code. Include package manager
   commands, environment prerequisites, and any required dependencies.

3. **Usage Examples** — Practical, copy-paste-ready code examples showing how to
   use the code. Include at least 2-3 examples covering common use cases.

4. **API Reference** — For each public function, class, or method, document:
   - Signature with parameter names and types
   - What each parameter does
   - Return values and types
   - Exceptions raised
   - A brief code example

5. **Configuration** — Any environment variables, config files, or settings
   that control behaviour. Provide defaults and valid values.

6. **Contributing** (optional) — How others can contribute to the project.

7. **License** (optional) — If applicable, note the license.

## Style Rules

- Use **Markdown** formatting: headings (`#`), code blocks with language tags,
  lists, tables, bold/italic, and links.
- Write in **clear, professional English** with active voice.
- Use **descriptive headings** that make the document easy to scan.
- Use **tables** for listing parameters, configuration options, or return values.
- Every public API element must be documented with its **type signature**.
- Assume the reader is a competent developer but not familiar with this
  specific codebase.
- Do **not** use placeholder text like "TODO" or "Coming soon". Write complete
  documentation based on what you see in the code context.
- If a section has no content to fill it (e.g. there is no configuration),
  you may omit it rather than writing "N/A".

Return your answer **only** as a JSON object with the following schema:
{
    "title": "A concise, descriptive title for the document",
    "content": "The complete Markdown documentation content"
}

Do **not** include any text outside of this JSON object.
""".strip()

_README_SYSTEM_PROMPT = """\
You are an expert technical writer specialising in project README files. \
Your job is to produce a polished, informative README.md for a software project.

You will be given:
1. A **task** describing what the project does or what the README should cover.
2. **Files context** — the actual source code, file listings, or other context \
about the project.

Write the README in **Markdown** format. A great README should include:

## Structure

1. **Project Title** — The name of the project, as a level-1 heading.

2. **Badges** (optional) — A row of badge images (build status, license, version,
   etc.) using Markdown image links.

3. **Overview / Description** — 2-4 sentences explaining what the project does,
   who it is for, and why it exists.

4. **Features** — A bullet-list of key features or capabilities.

5. **Installation** — Step-by-step instructions to get the project running
   locally. Include:
   - Prerequisites (language runtime, package manager, etc.)
   - Clone / download instructions
   - Package install command(s)
   - Any initial setup (environment variables, config files)

6. **Quick Start / Usage** — A minimal working example showing the project in
   action. Include code blocks with the actual commands or code.

7. **API / Commands Reference** (if applicable) — Document the public API,
   CLI commands, or main functions/classes.

8. **Configuration** (if applicable) — Environment variables, config files,
   or command-line options.

9. **Project Structure** (optional) — A brief tree view of important files
   and directories.

10. **Contributing** — Brief notes on how to contribute (even if minimal).

11. **License** — The project license.

## Style Rules

- Use **Markdown** formatting.
- Write in **clear, welcoming, professional English**.
- Use **fenced code blocks** with language identifiers for all code examples.
- Be **specific** — reference actual file names, function names, and commands
  that exist in the project.
- Do **not** use placeholder text.
- Be concise where possible — a README should be scannable, not a novel.
- If a section is not applicable (e.g. no configuration), you may omit it.

Return your answer **only** as a JSON object with the following schema:
{
    "title": "The project name, e.g. 'MyProject'",
    "content": "The complete README.md content"
}

Do **not** include any text outside of this JSON object.
""".strip()


# ── Internal Helpers ──────────────────────────────────────────────────────────


def _validate_model(model: str) -> Optional[str]:
    """Check if *model* is a known pricing key.

    Returns ``None`` if valid, or an error message string if unknown.
    """
    if model not in MODEL_PRICING:
        supported = ", ".join(MODEL_PRICING.keys())
        return (
            f"Unknown model '{model}'. Supported models: {supported}."
        )
    return None


def _track_api_cost(
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
) -> float:
    """Calculate the cost of an API call, add it to the session cost tracker,
    and return the calculated amount.

    Falls back to ``deepseek-chat`` pricing if the model is not found in
    ``MODEL_PRICING``.
    """
    try:
        cost = calculate_cost(model, prompt_tokens, completion_tokens)
    except (KeyError, TypeError):
        # Fallback for unknown models
        pricing = MODEL_PRICING.get("deepseek-chat", {"input": 0.27, "output": 1.10})
        input_cost = (prompt_tokens / 1_000_000) * pricing["input"]
        output_cost = (completion_tokens / 1_000_000) * pricing["output"]
        cost = input_cost + output_cost

    add_cost(cost)
    return cost


def _call_deepseek_doc(
    system_prompt: str,
    task: str,
    files_context: str,
    model: str,
) -> tuple[Optional[Dict[str, Any]], Optional[float], Optional[str]]:
    """Send the documentation generation request to DeepSeek and parse the
    JSON response.

    Parameters
    ----------
    system_prompt : str
        The system prompt guiding the model's behaviour (either the docs
        prompt or the README prompt).
    task : str
        The user's description of what documentation to generate.
    files_context : str
        Context about the project's files or source code.
    model : str
        The DeepSeek model identifier.

    Returns
    -------
    tuple of (parsed_dict | None, cost | None, error_message | None)
        On success, ``parsed_dict`` contains the ``title`` and ``content``
        fields and ``error_message`` is ``None``. On failure, ``parsed_dict``
        and ``cost`` are ``None`` and ``error_message`` describes the issue.
    """
    user_prompt = (
        f"## Documentation Task\n\n{task}\n\n"
        f"## Files Context\n\n{files_context}\n\n"
        "Please generate the documentation based on the above context."
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    try:
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.2,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        return None, None, f"DeepSeek API call failed: {exc}"

    # ── Track cost ───────────────────────────────────────────────────────
    usage = response.usage
    cost = 0.0
    if usage:
        cost = _track_api_cost(
            model,
            usage.prompt_tokens,
            usage.completion_tokens,
        )

    # ── Parse the JSON response ──────────────────────────────────────────
    raw_content = response.choices[0].message.content
    if not raw_content or not raw_content.strip():
        return None, cost, "Empty response from DeepSeek."

    try:
        parsed = json.loads(raw_content)
    except json.JSONDecodeError as exc:
        return (
            None,
            cost,
            f"Failed to parse response JSON: {exc}. Raw: {raw_content[:200]}",
        )

    # ── Validate structure ───────────────────────────────────────────────
    if not isinstance(parsed, dict):
        return None, cost, "Response is not a JSON object."

    if "title" not in parsed or not isinstance(parsed.get("title"), str):
        return None, cost, "Response is missing the 'title' field (string)."

    if "content" not in parsed or not isinstance(parsed.get("content"), str):
        return None, cost, "Response is missing the 'content' field (string)."

    if not parsed["content"].strip():
        return None, cost, "Generated documentation content is empty."

    return parsed, cost, None


# ── Public Generators ────────────────────────────────────────────────────────


def generate_docs(
    task: str,
    files_context: str,
    model: str = DEFAULT_MODEL,
) -> Generator[Dict[str, Any], None, None]:
    """Generate comprehensive documentation for a codebase or feature.

    This is a **generator** function that yields a sequence of event
    dictionaries. The caller should iterate over it to receive the
    documentation as it is being generated.

    Parameters
    ----------
    task : str
        The user's description of what documentation to generate. For example:
        *"Write API documentation for the authentication module"* or
        *"Document the CLI commands in main.py"*.
    files_context : str
        Contextual information about the project files. This can be a
        concatenation of file contents, a file tree listing, or any other
        text that helps the model understand what it is documenting.
    model : str, optional
        The DeepSeek model identifier to use. Defaults to ``"deepseek-chat"``.

    Yields
    ------
    dict
        Each yielded dict represents an SSE-style event:

        - ``{"type": "thinking", "content": "..."}``
          Status updates shown to the user while the agent is working.

        - ``{"type": "document", "title": "...", "content": "...",
             "format": "markdown"}``
          The generated documentation. ``title`` is a concise document title,
          ``content`` is the full Markdown body, and ``format`` is always
          ``"markdown"``.

        - ``{"type": "done", "content": "Documentation generated.",
             "cost": 0.0}``
          Signals that documentation generation is complete and provides
          the total session cost so far.

        - ``{"type": "error", "content": "...", "cost": 0.0}``
          An error occurred during generation.

    Examples
    --------
    >>> events = list(generate_docs(
    ...     "Document the API endpoints",
    ...     "# File: app.py\\nfrom flask import Flask\\n...",
    ... ))
    >>> events[-1]["type"]
    'done'

    >>> for event in generate_docs("Write docs", files_context="..."):
    ...     if event["type"] == "document":
    ...         print(f"Title: {event['title']}")
    ...         print(event["content"])
    """
    # ── Validate inputs ──────────────────────────────────────────────────
    if not task or not task.strip():
        yield {"type": "error", "content": "Task description cannot be empty.", "cost": get_session_cost()}
        return

    if not files_context or not files_context.strip():
        yield {"type": "error", "content": "Files context cannot be empty.", "cost": get_session_cost()}
        return

    model_error = _validate_model(model)
    if model_error:
        yield {"type": "error", "content": model_error, "cost": get_session_cost()}
        return

    # ── Phase 1: Thinking / preparing ────────────────────────────────────
    yield {"type": "thinking", "content": "Generating documentation..."}

    # ── Phase 2: Call DeepSeek ───────────────────────────────────────────
    yield {"type": "thinking", "content": "Analyzing code context and writing documentation..."}

    result, cost, error = _call_deepseek_doc(
        system_prompt=_DOCS_SYSTEM_PROMPT,
        task=task,
        files_context=files_context,
        model=model,
    )

    if error:
        yield {"type": "error", "content": error, "cost": get_session_cost()}
        return

    # result is guaranteed to have "title" and "content" at this point
    title = result["title"]
    content = result["content"]

    # ── Phase 3: Yield the document ──────────────────────────────────────
    yield {
        "type": "document",
        "title": title,
        "content": content,
        "format": "markdown",
    }

    # ── Phase 4: Signal completion ───────────────────────────────────────
    yield {
        "type": "done",
        "content": "Documentation generated.",
        "cost": get_session_cost(),
    }


def generate_readme(
    task: str,
    files_context: str,
    model: str = DEFAULT_MODEL,
) -> Generator[Dict[str, Any], None, None]:
    """Generate a polished README.md file for a project.

    This is a **generator** function that yields the same event types as
    :func:`generate_docs`. It is a specialised wrapper that provides a
    README-specific system prompt, guiding DeepSeek to produce a structured
    README with sections like Overview, Installation, Usage, API Reference,
    Configuration, Contributing, and License.

    Parameters
    ----------
    task : str
        A description of the project or what the README should cover. For
        example: *"A Python CLI tool for managing personal task lists"* or
        *"A web-based chat application built with Flask"*.
    files_context : str
        Contextual information about the project. This should include the
        project's file structure, key source files, configuration files,
        and any other information that helps the model describe the project
        accurately.
    model : str, optional
        The DeepSeek model identifier to use. Defaults to ``"deepseek-chat"``.

    Yields
    ------
    dict
        The same event types as :func:`generate_docs`:

        - ``{"type": "thinking", "content": "..."}``
        - ``{"type": "document", "title": "...", "content": "...",
             "format": "markdown"}``
        - ``{"type": "done", "content": "...", "cost": 0.0}``
        - ``{"type": "error", "content": "...", "cost": 0.0}``

    Examples
    --------
    >>> events = list(generate_readme(
    ...     "A Flask web app for code review",
    ...     "Project structure:\\n- app.py\\n- config.py\\n- ...",
    ... ))
    >>> doc_event = [e for e in events if e["type"] == "document"][0]
    >>> print(doc_event["content"][:200])
    # MyProject
    ...
    """
    # ── Validate inputs ──────────────────────────────────────────────────
    if not task or not task.strip():
        yield {"type": "error", "content": "Task description cannot be empty.", "cost": get_session_cost()}
        return

    if not files_context or not files_context.strip():
        yield {"type": "error", "content": "Files context cannot be empty.", "cost": get_session_cost()}
        return

    model_error = _validate_model(model)
    if model_error:
        yield {"type": "error", "content": model_error, "cost": get_session_cost()}
        return

    # ── Phase 1: Thinking / preparing ────────────────────────────────────
    yield {"type": "thinking", "content": "Generating README.md..."}

    # ── Phase 2: Call DeepSeek ───────────────────────────────────────────
    yield {"type": "thinking", "content": "Analyzing project and writing README..."}

    result, cost, error = _call_deepseek_doc(
        system_prompt=_README_SYSTEM_PROMPT,
        task=task,
        files_context=files_context,
        model=model,
    )

    if error:
        yield {"type": "error", "content": error, "cost": get_session_cost()}
        return

    title = result["title"]
    content = result["content"]

    # ── Phase 3: Yield the document ──────────────────────────────────────
    yield {
        "type": "document",
        "title": title,
        "content": content,
        "format": "markdown",
    }

    # ── Phase 4: Signal completion ───────────────────────────────────────
    yield {
        "type": "done",
        "content": "README.md generated.",
        "cost": get_session_cost(),
    }


# ── CLI Entry Point ──────────────────────────────────────────────────────────


if __name__ == "__main__":
    """CLI entry point for testing the Document Writer agent.

    Usage::

        python document_agent.py docs <task> [<files_context_file>]
        python document_agent.py readme <task> [<files_context_file>]

    If ``<files_context_file>`` is provided, the files context is read from
    that file. Otherwise, the tool prompts for context on stdin.
    """
    import sys

    def _print_event(event: Dict[str, Any]) -> None:
        """Pretty-print a single event dict to the console."""
        etype = event.get("type", "unknown")
        if etype == "thinking":
            print(f"🧠 {event['content']}")
        elif etype == "document":
            title = event.get("title", "Untitled")
            content = event.get("content", "")
            print(f"📄 **{title}** (format: {event.get('format', 'markdown')})")
            print("─" * 60)
            print(content)
            print("─" * 60)
        elif etype == "done":
            print(f"✅ {event['content']}")
            print(f"💰 Total session cost: ${event.get('cost', 0.0):.6f}")
        elif etype == "error":
            print(f"❌ {event['content']}")

    if len(sys.argv) < 2:
        print(__doc__)
        print("\nUsage:")
        print("  python document_agent.py docs <task> [files_context_file]")
        print("  python document_agent.py readme <task> [files_context_file]")
        sys.exit(1)

    command = sys.argv[1].lower()
    task_arg = sys.argv[2] if len(sys.argv) > 2 else input("Task: ").strip()

    # Read context from file if provided, otherwise from stdin
    files_context_arg = ""
    if len(sys.argv) > 3:
        context_path = sys.argv[3]
        try:
            with open(context_path, "r", encoding="utf-8") as f:
                files_context_arg = f.read()
        except OSError as exc:
            print(f"❌ Could not read context file '{context_path}': {exc}")
            sys.exit(1)
    else:
        print("📝 Enter files context (Ctrl+Z then Enter on Windows, or Ctrl+D on Unix to finish):")
        files_context_arg = sys.stdin.read()

    model_arg = os.environ.get("DOC_MODEL", DEFAULT_MODEL)

    if command == "docs":
        for event in generate_docs(task_arg, files_context_arg, model=model_arg):
            _print_event(event)
    elif command == "readme":
        for event in generate_readme(task_arg, files_context_arg, model=model_arg):
            _print_event(event)
    else:
        print(f"❌ Unknown command '{command}'. Use 'docs' or 'readme'.")
        sys.exit(1)
