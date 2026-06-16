import urllib.request, json

pipeline = {
    "requests": [
        {
            "type": "execute",
            "stmt": {
                "sql": "SELECT * FROM user_results WHERE user_id = 'dbnwQ0ZOxHdvO8xD2uiMuoKqCGi1'",
                "args": []
            }
        },
        {
            "type": "execute",
            "stmt": {
                "sql": "SELECT * FROM users WHERE id = 'dbnwQ0ZOxHdvO8xD2uiMuoKqCGi1'",
                "args": []
            }
        },
        {
            "type": "execute",
            "stmt": {
                "sql": "SELECT COUNT(*) AS zero_score_count FROM user_results WHERE user_id = 'dbnwQ0ZOxHdvO8xD2uiMuoKqCGi1' AND score = 0",
                "args": []
            }
        },
        {"type": "close"}
    ]
}

data = json.dumps(pipeline).encode()
req = urllib.request.Request("https://examforge-q88x.onrender.com/v2/pipeline", data=data, headers={"Content-Type": "application/json"})
resp = urllib.request.urlopen(req)
print(json.dumps(json.loads(resp.read()), indent=2))