import json,urllib.request
data=json.dumps({'requests':[{'type':'execute','stmt':{'sql':'SELECT 1 as test','args':[]}},{'type':'close'}]}).encode()