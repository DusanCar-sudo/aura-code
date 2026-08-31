import re
with open('/mnt/bigdata/aura/projects/resume/DM_Resume_option2_modern_1-3.html', 'r', encoding='utf-8') as f:
    text = f.read()

# find body
body = text[text.find('<body>'):]
# replace all html tags with a separator so we can see structure
body = re.sub(r'<div[^>]*>', '\n---DIV---\n', body)
body = re.sub(r'</div>', '\n---/DIV---\n', body)
body = re.sub(r'<[^>]+>', ' ', body)
# replace multiple spaces with single space
text = re.sub(r'[ \t]+', ' ', body)
# replace multiple newlines with single newline
text = re.sub(r'\n\s*\n', '\n', text)
print(text[:4000])
