with open('app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()
line = lines[7829]  # line 7830, 0-indexed
print(f'Length: {len(line)}')
for i, ch in enumerate(line):
    if ord(ch) > 127:
        print(f'Position {i}: U+{ord(ch):04X} = {repr(ch)}')
# Also check for non-standard spaces and dots
print('Hex dump of first 60 chars:')
for i, ch in enumerate(line[:60]):
    print(f'  pos {i}: U+{ord(ch):04X} = {repr(ch)}')
