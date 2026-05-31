from flask import Flask, request, jsonify, send_from_directory
from agent import (
    modify_code, answer_question, rollback,
    classify_intent, clear_history, get_session_cost, reset_session_cost
)

app = Flask(__name__)

@app.route("/")
def index():
    return send_from_directory("static", "index.html")

@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json()
    message = data.get("message", "").strip()
    if not message:
        return jsonify({"status": "error", "message": "No message provided."})

    # Special commands
    if message.lower() in ["clear history", "reset", "forget"]:
        msg = clear_history()
        reset_session_cost()
        return jsonify({"status": "success", "message": msg, "total_cost": 0.0})

    # Classify intent
    intent_data = classify_intent(message)
    intent = intent_data.get("intent", "modify")
    push = intent_data.get("push", True)
    task = intent_data.get("task", message)

    if intent == "modify":
        result = modify_code(task, push=push)
    elif intent == "question":
        result = answer_question(task)
    elif intent == "rollback":
        result = rollback(push=push)
    else:
        result = {"status": "error", "message": "Unknown intent."}

    # Attach total session cost
    result["total_cost"] = get_session_cost()
    return jsonify(result)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)