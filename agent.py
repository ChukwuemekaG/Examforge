import os, sys, re, openai
from git import Repo, GitCommandError

DEEPSEEK_API_KEY = os.environ["DEEPSEEK_API_KEY"]
GIT_TOKEN = os.environ["GIT_TOKEN"]
REPO_PATH = "/workspaces/" + os.environ["RepositoryName"]

client = openai.OpenAI(
    api_key=DEEPSEEK_API_KEY,
    base_url="https://api.deepseek.com",
)

def get_repo():
    return Repo(REPO_PATH)

def run_agent(task: str):
    repo = get_repo()
    origin = repo.remotes.origin

    # 1. Fetch all and go to the default branch (main/master)
    origin.fetch()
    # Determine default branch from remote HEAD
    default_branch = repo.git.symbolic_ref("refs/remotes/origin/HEAD").split("/")[-1]
    print(f"📌 Default branch: {default_branch}")

    # Checkout default branch
    repo.git.checkout(default_branch)
    # Pull latest
    try:
        origin.pull()
        print("✅ Pulled latest changes.")
    except GitCommandError as e:
        print(f"⚠️  Pull failed (maybe no tracking): {e}")

    # 2. Create a clean branch name
    safe_task = re.sub(r'[^a-z0-9]+', '-', task.lower()).strip('-')[:40]
    branch_name = f"agent/{safe_task}"
    # Delete if already exists locally
    if branch_name in repo.heads:
        repo.delete_head(branch_name, force=True)
    repo.git.checkout("-b", branch_name)
    print(f"🌿 New branch: {branch_name}")

    # 3. Gather repo file tree for context
    file_list = []
    ignore_dirs = {".git", "node_modules", "venv", "__pycache__"}
    for root, dirs, files in os.walk(REPO_PATH):
        dirs[:] = [d for d in dirs if d not in ignore_dirs]
        for name in files:
            file_list.append(os.path.relpath(os.path.join(root, name), REPO_PATH))
    context = "Repo file tree:\n" + "\n".join(file_list)

    # 4. Ask DeepSeek to implement the task via function calling
    tools = [
        {
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
        }
    ]

    messages = [
        {"role": "system", "content": "You are an expert dev assistant. Use the write_file tool to implement changes. Always provide the full file content for any file you modify."},
        {"role": "user", "content": f"Task: {task}\n\nRepo context:\n{context}"}
    ]

    print("🧠 Calling DeepSeek...")
    response = client.chat.completions.create(
        model="deepseek-chat",
        messages=messages,
        tools=tools,
        tool_choice="auto",
        temperature=0.2
    )

    tool_calls = response.choices[0].message.tool_calls
    if not tool_calls:
        print("❌ Agent didn't use any tools. Message:", response.choices[0].message.content)
        return

    # 5. Apply file writes
    for call in tool_calls:
        if call.function.name == "write_file":
            args = eval(call.function.arguments)
            file_path = os.path.join(REPO_PATH, args["path"])
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            with open(file_path, "w") as f:
                f.write(args["content"])
            print(f"✅ Written: {args['path']}")

    # 6. Commit and push using PAT
    repo.git.add(all=True)
    commit_msg = f"AI agent: {task}"
    repo.index.commit(commit_msg)

    # Set remote URL with token for push
    repo_url = f"https://x-access-token:{GIT_TOKEN}@github.com/{os.environ['GITHUB_REPOSITORY']}.git"
    origin.set_url(repo_url)
    origin.push(branch_name)
    print(f"🚀 Pushed branch '{branch_name}' to origin.")

    # Print a link to create a PR
    print(f"\n👉 Create a PR: https://github.com/{os.environ['GITHUB_REPOSITORY']}/pull/new/{branch_name}")

if __name__ == "__main__":
    task = sys.argv[1] if len(sys.argv) > 1 else input("Enter task: ")
    run_agent(task)