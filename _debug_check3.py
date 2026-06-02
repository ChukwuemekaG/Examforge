with open('app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()
# Check lines 7817-7824 for template literal (backtick) issues
for i in range(7816, 7825):
    line_num = i + 1
    line = lines[i]
    backtick_count = line.count('`')
    print(f'Line {line_num}: backticks={backtick_count} | {repr(line[:100])}')

print()
# Check also the larger context - count backticks from 7816 to 7835
total_backticks = sum(lines[i].count('`') for i in range(7816, 7836))
print(f'Total backticks from lines 7817-7836: {total_backticks}')
# If odd, template literal is unclosed
