"""
Plan Agent Module for TalkCody.

This module provides the Plan agent, which takes a user's task description
and generates a structured, step-by-step implementation plan using the
DeepSeek API (OpenAI-compatible SDK). The plan identifies which files
need to be modified, the actions required, and provides an estimated
difficulty rating for the task.

The primary entry point is the generator function ``generate_plan()``,
which yields SSE-style event dictionaries suitable for streaming to
a client interface.

Typical usage::

    from plan_agent import generate_plan

    for event in generate_plan("Add dark mode toggle", files_context="..."):
        if event["type"] == "plan":
            print("Plan:", event["content"])
        elif event["type"] == "question":
            print("Question:", event["content"])
        elif event["type"] == "done":
            print("Done:", event["content"])
"""

import json
from typing import Any, Dict, Generator, List, Optional

# ── Shared dependencies from the main agent module ─────────
from config import (
    MODEL_PRICING,
    add_cost,
    calculate_cost,
    client,
    get_session_cost,
)


# ── Constants ───────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are an expert software engineer and technical architect. Your job is to \
analyze a user's task in the context of their project and produce a clear, \
actionable implementation plan.

First, restate what the user wants in your own words to confirm understanding.
Then, break the task into numbered, sequential steps. For each step, specify:
- The exact action to perform (e.g. "Create file", "Modify function", "Add import")
- The files that need to be touched

Finally, rate the overall difficulty of the task as "easy", "medium", or "hard".

Return your answer **only** as a JSON object with the following schema:
{
    "summary": "A one-paragraph restatement of what the user wants.",
    "steps": [
        {
            "step": 1,
            "action": "Description of what to do in this step.",
            "files": ["path/to/file1.ext", "path/to/file2.ext"]
        }
    ],
    "estimated_difficulty": "easy|medium|hard"
}
"""

_DEFAULT_MODEL = "deepseek-chat"

# ── Plan Approval State ────────────────────────────────────
# The current plan approval state, set via the /plan/approve endpoint.
# Initialised to ``None`` (not yet decided); the agent checks this
# after yielding a "question" event to see if the user has responded.
_plan_approved: bool | None = None


def set_plan_approval(approved: bool) -> None:
    """Set the plan approval state from the /plan/approve endpoint.

    Parameters
    ----------
    approved : bool
        ``True`` if the user approved the plan, ``False`` if rejected.
    """
    global _plan_approved
    _plan_approved = approved


def get_plan_approval() -> bool | None:
    """Return the current plan approval state, resetting it to ``None``.

    Returns
    -------
    bool | None
        ``True`` if approved, ``False`` if rejected, ``None`` if undecided.
        The internal state is reset to ``None`` after reading.
    """
    global _plan_approved
    val = _plan_approved
    _plan_approved = None
    return val


# ── Public API ──────────────────────────────────────────────


def generate_plan(
    task: str,
    files_context: str,
    model: str = _DEFAULT_MODEL,
) -> Generator[Dict[str, Any], None, None]:
    """Generate a structured implementation plan for *task*.

    This is a **generator** function that yields a sequence of event
    dictionaries.  The caller should iterate over it to receive the
    plan as it is being built.

    Parameters
    ----------
    task : str
        The user's natural-language task description (e.g. "Add a dark-mode
        toggle button to the header").
    files_context : str
        Contextual information about the project's files.  This can be a
        string representation of the file tree, file contents, or any other
        relevant information that helps the model understand the codebase.
    model : str, optional
        The DeepSeek model identifier to use.  Defaults to ``"deepseek-chat"``.

    Yields
    ------
    dict
        Each yielded dict represents an SSE-style event:

        - ``{"type": "thinking", "content": "…"}`` – Status updates shown to
          the user while the agent is working.
        - ``{"type": "plan", "steps": […], "content": "…"}`` – The generated
          plan, containing a list of steps and a human-readable summary.
        - ``{"type": "question", "content": "…"}`` – A question directed at
          the user (e.g. asking for plan approval).
        - ``{"type": "done", "content": "…", "cost": 0.0}`` – Signals that
          the planning phase is complete.
        - ``{"type": "error", "content": "…", "cost": 0.0}`` – An error
          occurred during planning.

    Examples
    --------
    >>> events = list(generate_plan("Refactor auth middleware", "src/auth/…"))
    >>> events[-1]["type"]
    'done'
    """
    # ── Validate inputs ────────────────────────────────────
    if not task or not task.strip():
        yield _error("Task description cannot be empty.")
        return

    if not files_context or not files_context.strip():
        yield _error("Files context cannot be empty.")
        return

    # ── 1. Show thinking state ──────────────────────────────
    yield _thinking("Analyzing request...")

    # ── 2. Build the API request ────────────────────────────
    user_prompt = (
        f"Task from user:\n{task}\n\n"
        f"Project files / context:\n{files_context}\n\n"
        "Please produce a detailed implementation plan in JSON format."
    )

    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    # ── 3. Call DeepSeek API ────────────────────────────────
    try:
        yield _thinking("Generating plan...")

        response = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.2,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        yield _error(f"DeepSeek API call failed: {exc}")
        return

    # ── 4. Track cost ──────────────────────────────────────
    usage = response.usage
    prompt_tokens = usage.prompt_tokens
    completion_tokens = usage.completion_tokens

    try:
        cost = calculate_cost(model, prompt_tokens, completion_tokens)
    except KeyError:
        # Fallback for unknown models – use deepseek-chat pricing
        pricing = MODEL_PRICING.get("deepseek-chat", {"input": 0.27, "output": 1.10})
        input_cost = (prompt_tokens / 1_000_000) * pricing["input"]
        output_cost = (completion_tokens / 1_000_000) * pricing["output"]
        cost = input_cost + output_cost

    add_cost(cost)

    # ── 5. Parse the JSON response ─────────────────────────
    raw_content = response.choices[0].message.content

    try:
        plan_data = json.loads(raw_content)
    except (json.JSONDecodeError, TypeError) as exc:
        yield _error(f"Failed to parse plan JSON: {exc}")
        return

    # Validate that the parsed data has the expected structure
    validation_error = _validate_plan(plan_data)
    if validation_error:
        yield _error(validation_error)
        return

    summary = plan_data.get("summary", "No summary provided.")
    steps = plan_data.get("steps", [])
    difficulty = plan_data.get("estimated_difficulty", "unknown")

    # ── 6. Yield the plan event ────────────────────────────
    plan_content = _format_plan_text(summary, steps, difficulty)

    yield {
        "type": "plan",
        "steps": steps,
        "summary": summary,
        "estimated_difficulty": difficulty,
        "content": plan_content,
    }

    # ── 7. Ask the user for approval ────────────────────────
    yield {
        "type": "question",
        "content": "Do you approve this plan?",
    }

    # ── 8. Signal completion ────────────────────────────────
    yield {
        "type": "done",
        "content": "Plan approved.",
        "cost": get_session_cost(),
    }


# ── Internal helpers ────────────────────────────────────────


def _validate_plan(data: Any) -> Optional[str]:
    """Validate that *data* has the expected plan structure.

    Returns ``None`` when the structure is valid, or an error message
    string describing the first validation failure.
    """
    if not isinstance(data, dict):
        return "Plan response is not a JSON object."

    if "summary" not in data or not isinstance(data["summary"], str):
        return "Plan response is missing the 'summary' field (string)."

    if "steps" not in data or not isinstance(data["steps"], list):
        return "Plan response is missing the 'steps' field (list)."

    if len(data["steps"]) == 0:
        return "Plan contains zero steps – unable to proceed."

    for i, step in enumerate(data["steps"]):
        if not isinstance(step, dict):
            return f"Step {i + 1} is not a JSON object."
        if "action" not in step or not isinstance(step["action"], str):
            return f"Step {i + 1} is missing the 'action' field (string)."
        if "files" not in step or not isinstance(step["files"], list):
            return f"Step {i + 1} is missing the 'files' field (list)."

    if "estimated_difficulty" not in data:
        return "Plan response is missing the 'estimated_difficulty' field."

    valid_difficulties = {"easy", "medium", "hard"}
    if data["estimated_difficulty"] not in valid_difficulties:
        return (
            f"Invalid 'estimated_difficulty': '{data['estimated_difficulty']}'. "
            f"Must be one of {', '.join(sorted(valid_difficulties))}."
        )

    return None


def _format_plan_text(
    summary: str,
    steps: List[Dict[str, Any]],
    difficulty: str,
) -> str:
    """Produce a human-readable Markdown description of the plan."""
    lines: List[str] = [
        f"**Summary**: {summary}",
        "",
        f"**Estimated difficulty**: {difficulty}",
        "",
        "**Steps**:",
    ]

    for step in steps:
        step_num = step.get("step", "")
        action = step.get("action", "No description")
        files = step.get("files", [])

        lines.append(f"")
        lines.append(f"  **Step {step_num}.** {action}")
        if files:
            for file_path in files:
                lines.append(f"    - `{file_path}`")

    lines.append("")
    return "\n".join(lines)


def _thinking(content: str) -> Dict[str, str]:
    """Build a ``thinking`` event dict."""
    return {"type": "thinking", "content": content}


def _error(content: str) -> Dict[str, Any]:
    """Build an ``error`` event dict with current session cost."""
    return {"type": "error", "content": content, "cost": get_session_cost()}
