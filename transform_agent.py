# Write the transform script  
import sys  
sys.stdout.reconfigure(encoding='utf-8')  
  
with open(r'C:\Projects\Examforge\agent.py', 'r', encoding='utf-8') as f:  
    content = f.read()  
print('Read agent.py:', len(content), 'bytes') 
