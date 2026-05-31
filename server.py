"""
TalkCody Flask Server

Serves the chat UI and exposes SSE and REST endpoints that connect
to the orchestrator agent and memory system.
"""

import json

from flask import Flask, request, send_from_directory, Response, stream_with_context
from agent import run_agent, reset_session, get_session_cost
import memory as memory_module

app = Flask(__name__)


# ── Static Routes ─────────────────────────────────────────────────────────────


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# ── SSE Streaming ────────────────────────────────────────────────────────────


@app.route("/stream", methods=["POST"])
def stream():
    data = request.get_json()
    message = data.get("message", "").strip()
    model = data.get("model", "deepseek-chat")
    auto_deploy = data.get("auto_deploy", False)

    # ── Session reset ─────────────────────────────────────────────────────
    if message.lower() in {"clear history", "reset", "forget"}:
        reset_session()

        def clear_gen():
            yield f"data: {json.dumps({'type': 'done', 'message': 'History cleared.'})}\n\n"
            yield f"data: {json.dumps({'type': 'stream_end'})}\n\n"

        return Response(stream_with_context(clear_gen()), mimetype="text/event-stream")

    # ── Agent streaming ───────────────────────────────────────────────────
    def generate():
        for event in run_agent(message, model, auto_deploy):
            event["total_cost"] = get_session_cost()
            yield f"data: {json.dumps(event)}\n\n"

            # If the agent asks a question, stop here — the client will
            # re-send the same request with the answer included.
            if event.get("type") == "question":
                break

        yield f"data: {json.dumps({'type': 'stream_end'})}\n\n"

    return Response(stream_with_context(generate()), mimetype="text/event-stream")


# ── Memory API ───────────────────────────────────────────────────────────────


@app.route("/memory", methods=["POST"])
def memory():
    data = request.get_json() or {}
    action = data.get("action", "read")
    target = data.get("target", "index")
    scope = data.get("scope", "project")
    content = data.get("content", "")
    file_name = data.get("file_name")

    if action == "write":
        success = memory_module.memory_write(
            target=target,
            scope=scope,
            content=content,
            file_name=file_name,
        )
        return {"status": "ok" if success else "error", "success": success}

    # Default: read
    result = memory_module.memory_read(
        target=target,
        scope=scope,
        file_name=file_name,
    )
    return {"status": "ok", "data": result}


# ── Plan Approval ────────────────────────────────────────────────────────────


@app.route("/plan/approve", methods=["POST"])
def plan_approve():
    data = request.get_json() or {}
    approved = data.get("approved", False)
    # The approval state is read by plan_agent via a simple module-level
    # variable so the agent can block on user confirmation.
    from plan_agent import set_plan_approval
    set_plan_approval(approved)
    return {"status": "ok"}


# ── Entry Point ──────────────────────────────────────────────────────────────


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
