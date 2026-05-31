import os, sys, re, json
import openai
from git import Repo, GitCommandError

# ── CONFIG ───────────────────────────────────────────────────
DEEPSEEK_API_KEY = os.environ["DEEPSEEK_API_KEY"]
GIT_TOKEN = os.environ["GIT_TOKEN"]
REPO_PATH = "/workspaces/" + os.environ["RepositoryName"]
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

client = openai.OpenAI(
    api_key=DEEPSEEK_API_KEY,
    base_url="https://api.deepseek.com",
)

# Pricing
MODEL_PRICING = {
    "deepseek-chat":      {"input": 0.27, "output": 1.10},
    "deepseek-reasoner":  {"input": 0.55, "output": 2.19},
}

session_total_cost = 0.0

def calculate_cost(model, prompt_tokens, completion_tokens):
    pricing = MODEL_PRICING.get(model)
    if not pricing:
        return 0.0
    input_cost = (prompt_tokens / 1_000_000) * pricing["input"]
    output_cost = (completion_tokens / 1_000_000) * pricing["output"]
    return input_cost + output_cost

def add_cost(amount):
    global session_total_cost
    session_total_cost += amount

def get_session_cost():
    return session_total_cost

def reset_session_cost():
    global session_total_cost
    session_total_cost = 0.0

# Conversation memory
conversation_history = []

def add_to_history(role, content):
    conversation_history.append({"role": role, "content": content})

def get_history():
    return conversation_history.copy()

def clear_history():
    global conversation_history, session_total_cost
    conversation_history.clear()
    session_total_cost = 0.0
    return "🧹 Conversation history and cost cleared."

# ── Repo helpers ────────────────────────────────────────────
def get_repo():
    repo = Repo(REPO_PATH)
    origin = repo.remotes.origin
    return repo, origin

# ── 1. Modify code ──────────────────────────────────────────
def modify_code(task: str, push: bool = True):
    repo, origin = get_repo()
    origin.fetch()
    default_branch = repo.git.symbolic_ref("refs/remotes/origin/HEAD").split("/")[-1]
    repo.git.checkout(default_branch)
    try:
        origin.pull()
    except GitCommandError:
        pass

    safe_name = re.sub(r'[^a-z0-9]+', '-', task.lower()).strip('-')[:40]
    branch_name = f"agent/{safe_name}"
    if branch_name in repo.heads:
        repo.delete_head(branch_name, force=True)
    repo.git.checkout("-b", branch_name)

    file_list = []
    ignore = {".git", "node_modules", "venv", "__pycache__"}
    for root, dirs, files in os.walk(REPO_PATH):
        dirs[:] = [d for d in dirs if d not in ignore]
        for name in files:
            file_list.append(os.path.relpath(os.path.join(root, name), REPO_PATH))
    context = "Repo file tree:\n" + "\n".join(file_list)

    tools = [{
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write or overwrite a file with full content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative file path"},
                    "content": {"type": "string", "description": "Complete new content"}
                },
                "required": ["path", "content"]
            }
        }
    }]

    system_msg = {"role": "system", "content": "You are an expert developer. Use the write_file tool to implement the requested changes. Always provide the full file content for any file you modify."}
    messages = [system_msg] + get_history() + [{"role": "user", "content": f"Task: {task}\n\nRepo context:\n{context}"}]

    response = client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        messages=messages,
        tools=tools,
        tool_choice="auto",
        temperature=0.2
    )

    usage = response.usage
    cost = calculate_cost(DEEPSEEK_MODEL, usage.prompt_tokens, usage.completion_tokens)
    add_cost(cost)
    tokens_info = f"Prompt: {usage.prompt_tokens} | Completion: {usage.completion_tokens} | Total: {usage.total_tokens}"
    cost_info = f"${cost:.6f} (session total: ${get_session_cost():.6f})"

    add_to_history("user", task)
    assistant_msg = response.choices[0].message.content or "Used tools to modify files."
    add_to_history("assistant", assistant_msg)

    tool_calls = response.choices[0].message.tool_calls
    if not tool_calls:
        return {"status": "error", "message": f"Agent didn't use any tools. {assistant_msg}", "tokens": tokens_info, "cost": cost_info}

    written = []
    for call in tool_calls:
        if call.function.name == "write_file":
            args = json.loads(call.function.arguments)
            file_path = os.path.join(REPO_PATH, args["path"])
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            with open(file_path, "w") as f:
                f.write(args["content"])
            written.append(args["path"])

    repo.git.add(all=True)
    repo.index.commit(f"AI agent: {task}")

    if push:
        repo_url = f"https://x-access-token:{GIT_TOKEN}@github.com/{os.environ['GITHUB_REPOSITORY']}.git"
        origin.set_url(repo_url)
        origin.push(branch_name)
        pr_link = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/pull/new/{branch_name}"
        return {
            "status": "success",
            "message": f"✅ Files written: {', '.join(written)}.\nBranch `{branch_name}` pushed.",
            "pr_link": pr_link,
            "tokens": tokens_info,
            "cost": cost_info
        }
    else:
        return {
            "status": "success",
            "message": f"✅ Files written: {', '.join(written)}.\nCommitted locally on branch `{branch_name}` (not pushed).",
            "tokens": tokens_info,
            "cost": cost_info
        }

# ── 2. Answer question ─────────────────────────────────────
def answer_question(question: str):
    file_list = []
    ignore = {".git", "node_modules", "venv", "__pycache__"}
    for root, dirs, files in os.walk(REPO_PATH):
        dirs[:] = [d for d in dirs if d not in ignore]
        for name in files:
            file_list.append(os.path.relpath(os.path.join(root, name), REPO_PATH))

    contents = ""
    for fpath in file_list:
        if any(fpath.endswith(ext) for ext in [".html", ".js", ".css", ".json", ".md", ".yml", ".yaml", ".txt", ".py", ".ts", ".jsx", ".tsx"]):
            try:
                with open(os.path.join(REPO_PATH, fpath), "r") as f:
                    contents += f"\n--- {fpath} ---\n" + f.read()[:2000]
            except:
                pass

    system_msg = {"role": "system", "content": "You are a helpful coding assistant that answers questions about the codebase. Use the provided file contents to give a concise, accurate answer. Format your answer using Markdown when helpful."}
    messages = [system_msg] + get_history() + [{"role": "user", "content": f"Repository files:\n{contents}\n\nUser question: {question}"}]

    response = client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        messages=messages,
        temperature=0.3
    )

    usage = response.usage
    cost = calculate_cost(DEEPSEEK_MODEL, usage.prompt_tokens, usage.completion_tokens)
    add_cost(cost)
    tokens_info = f"Prompt: {usage.prompt_tokens} | Completion: {usage.completion_tokens} | Total: {usage.total_tokens}"
    cost_info = f"${cost:.6f} (session total: ${get_session_cost():.6f})"

    answer = response.choices[0].message.content
    add_to_history("user", question)
    add_to_history("assistant", answer)
    return {"status": "success", "message": answer, "tokens": tokens_info, "cost": cost_info}

# ── 3. Rollback ─────────────────────────────────────────────
def rollback(push: bool = True):
    repo, origin = get_repo()
    origin.fetch()
    default_branch = repo.git.symbolic_ref("refs/remotes/origin/HEAD").split("/")[-1]
    repo.git.checkout(default_branch)
    try:
        origin.pull()
    except:
        pass

    try:
        repo.git.revert("HEAD", no_edit=True)
        msg = "✅ Last commit reverted."
    except GitCommandError as e:
        return {"status": "error", "message": f"❌ Revert failed: {e}"}

    if push:
        repo_url = f"https://x-access-token:{GIT_TOKEN}@github.com/{os.environ['GITHUB_REPOSITORY']}.git"
        origin.set_url(repo_url)
        origin.push()
        msg += " Revert pushed to origin."

    add_to_history("user", "rollback last commit" + (" and push" if push else ""))
    add_to_history("assistant", "Rollback performed.")
    return {"status": "success", "message": msg, "tokens": "N/A", "cost": "N/A"}

# ── Intent classifier ────────────────────────────────────────
def classify_intent(user_input: str) -> dict:
    system = """You are a command parser. Determine intent: "modify", "question", or "rollback". Extract push (boolean). Default true unless user says "don't push". Return JSON: {"intent": "...", "push": true/false, "task": "..."}"""
    resp = client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user_input}],
        temperature=0,
        response_format={"type": "json_object"}
    )
    usage = resp.usage
    cost = calculate_cost(DEEPSEEK_MODEL, usage.prompt_tokens, usage.completion_tokens)
    add_cost(cost)
    return json.loads(resp.choices[0].message.content)

# ── Terminal main ────────────────────────────────────────────
if __name__ == "__main__":
    user_cmd = sys.argv[1] if len(sys.argv) > 1 else input("🤖 What should I do? ").strip()
    if user_cmd.lower() in ["clear history", "reset", "forget"]:
        print(clear_history())
        sys.exit(0)

    intent_data = classify_intent(user_cmd)
    intent = intent_data.get("intent", "modify")
    push = intent_data.get("push", True)
    task = intent_data.get("task", user_cmd)

    if intent == "modify":
        res = modify_code(task, push=push)
    elif intent == "question":
        res = answer_question(task)
    elif intent == "rollback":
        res = rollback(push=push)
    else:
        print("❌ Unknown intent.")
        sys.exit(1)

    print(f"\n{res['message']}")
    if "tokens" in res:
        print(f"🔢 {res['tokens']}")
    if "cost" in res:
        print(f"💵 {res['cost']}")
    if "pr_link" in res:
        print(f"👉 PR: {res['pr_link']}")