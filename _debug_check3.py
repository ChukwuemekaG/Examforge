"""Query Turso with the 3 specific queries requested."""
import urllib.request, json

PROXY_URL = "https://examforge-q88x.onrender.com/v2/pipeline"
USER_ID = "dbnwQ0ZOxHdvO8xD2uiMuoKqCGi1"

pipeline = {
    "requests": [
        # Query 1: Any user_results for this user with key columns
        {
            "type": "execute",
            "stmt": {
                "sql": f"SELECT id, course, score, grade, created_at FROM user_results WHERE user_id = '{USER_ID}' ORDER BY created_at DESC",
                "args": []
            }
        },
        # Query 2: Check exa_rating for this user
        {
            "type": "execute",
            "stmt": {
                "sql": f"SELECT exa_rating, streak, highest_streak, last_exam_date FROM users WHERE id = '{USER_ID}'",
                "args": []
            }
        },
        # Query 3: All distinct user_ids in user_results
        {
            "type": "execute",
            "stmt": {
                "sql": "SELECT DISTINCT user_id FROM user_results ORDER BY user_id",
                "args": []
            }
        },
        {"type": "close"}
    ]
}

data = json.dumps(pipeline).encode()
req = urllib.request.Request(
    PROXY_URL,
    data=data,
    headers={"Content-Type": "application/json"}
)

resp = urllib.request.urlopen(req)
result = json.loads(resp.read())
print(json.dumps(result, indent=2))
