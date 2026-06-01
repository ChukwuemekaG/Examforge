import os
s1 = os.path.getsize('C:/Projects/talk/static/index.html')
s2 = os.path.getsize('C:/Projects/Examforge/static/index.html')
print('talk:', s1)
print('examforge:', s2)
print('same:', s1 == s2)
