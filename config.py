"""
Shared configuration module for the TalkCody project.

Provides the DeepSeek API client, cost tracking functions, model pricing,
and the project root path.  This module is fully self-contained and does
**not** import from ``agent.py`` (avoiding circular dependencies).  All
sub-agent modules (``plan_agent``, ``coding_agent``, ``review_agent``,
``document_agent``, ``test_agent``, ``explore_agent``) should import from
here rather than duplicating these values.

Usage::

    from config import (
        PROJECT_ROOT,
        MODEL_PRICING,
        DEFAULT_MODEL,
        client,
        calculate_cost,
        add_cost,
        get_session_cost,
        reset_session,
    )
"""

import os
from pathlib import Path

import openai

# ── Paths ─────────────────────────────────────────────────────────────────────

PROJECT_ROOT: Path = Path(__file__).parent.resolve()
"""
Absolute path to the project root directory.

This value is auto-detected from the location of this ``config.py`` file,
so it works on any operating system and machine without manual edits.
"""

# ── API & Auth ────────────────────────────────────────────────────────────────

DEEPSEEK_API_KEY: str = os.environ["DEEPSEEK_API_KEY"]
"""
DeepSeek API key read from the ``DEEPSEEK_API_KEY`` environment variable.

Raises ``KeyError`` if the variable is not set.
"""

GIT_TOKEN: str = os.environ.get("GIT_TOKEN", "")
"""
Personal access token for Git operations, read from the ``GIT_TOKEN``
environment variable.  Defaults to an empty string if not set.
"""

GITHUB_REPO: str = os.environ.get("GITHUB_REPOSITORY", "")
"""
GitHub repository identifier (e.g. ``"owner/repo"``), read from the
``GITHUB_REPOSITORY`` environment variable.  Defaults to an empty string
if not set.
"""

REPO_NAME: str = os.environ.get("RepositoryName", "")
"""
Repository name, read from the ``RepositoryName`` environment variable.
Defaults to an empty string if not set.
"""

# ── Model Configuration ───────────────────────────────────────────────────────

MODEL_PRICING: dict = {
    "deepseek-v4-flash": {"input": 0.27, "output": 1.10},
    "deepseek-v4-pro":   {"input": 0.55, "output": 2.19},
}
"""
Pricing per model in USD per million tokens.

Keys are model names; each value is a dict with ``"input"`` and
``"output"`` prices.

.. code-block:: python

    MODEL_PRICING = {
        "deepseek-v4-flash": {"input": 0.27, "output": 1.10},   # $/1M tokens
        "deepseek-v4-pro":   {"input": 0.55, "output": 2.19},   # $/1M tokens
    }
"""

DEFAULT_MODEL: str = "deepseek-v4-flash"
"""
The default model identifier used when no explicit model is specified.
"""

# ── API Client ────────────────────────────────────────────────────────────────

client = openai.OpenAI(
    api_key=DEEPSEEK_API_KEY,
    base_url="https://api.deepseek.com",
)
"""
Shared ``openai.OpenAI`` client instance configured to talk to the
DeepSeek API (``https://api.deepseek.com``).
"""

# ── Session Cost Tracking ─────────────────────────────────────────────────────

_session_total_cost: float = 0.0
"""
Internal running total of API call costs for the current session, in USD.
Accessed via :func:`get_session_cost`, :func:`add_cost`, and
:func:`reset_session`.
"""


def calculate_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Calculate the cost of an API call in USD.

    Uses the per-model pricing in :data:`MODEL_PRICING`.  If *model*
    is not found in the pricing table, falls back to
    ``deepseek-v4-flash`` pricing.

    Parameters
    ----------
    model : str
        The model identifier (e.g. ``"deepseek-v4-flash"``).
    prompt_tokens : int
        Number of input (prompt) tokens consumed.
    completion_tokens : int
        Number of output (completion) tokens generated.

    Returns
    -------
    float
        Total cost in US dollars.

    Example
    -------
    >>> calculate_cost("deepseek-v4-flash", 500_000, 100_000)
    0.245
    """
    pricing = MODEL_PRICING.get(model, MODEL_PRICING["deepseek-v4-flash"])
    input_cost = (prompt_tokens / 1_000_000) * pricing["input"]
    output_cost = (completion_tokens / 1_000_000) * pricing["output"]
    return input_cost + output_cost


def add_cost(amount: float) -> None:
    """Add *amount* (USD) to the running session total.

    Parameters
    ----------
    amount : float
        Cost in US dollars to add.  Typically the return value of
        :func:`calculate_cost`.

    Example
    -------
    >>> add_cost(0.245)
    """
    global _session_total_cost  # noqa: PLW0603
    _session_total_cost += amount


def get_session_cost() -> float:
    """Return the accumulated API cost for the current session, in USD.

    Returns
    -------
    float
        Running total of all :func:`add_cost` calls made during this
        session.

    Example
    -------
    >>> get_session_cost()
    0.245
    """
    return _session_total_cost


def reset_session() -> None:
    """Reset the session cost tracker to zero.

    Call this when starting a new conversation or clearing history.

    Example
    -------
    >>> reset_session()
    >>> get_session_cost()
    0.0
    """
    global _session_total_cost  # noqa: PLW0603
    _session_total_cost = 0.0
