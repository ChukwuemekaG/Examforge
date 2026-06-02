with open('app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()
for i in range(7824, 7836):
    line_num = i + 1
    line = lines[i]
    print(f'Line {line_num}: {repr(line[:120])}')
