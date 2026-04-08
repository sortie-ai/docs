#!/usr/bin/env python3
"""
apply-frontmatter.py

Apply front matter transformation to Hugo content files:
- Strip ' | Sortie' suffix from title
- Set date from creation-dates mapping
- Set weight
- Set url (optional)
"""
import sys
import os
import re

def load_creation_dates(dates_file):
    dates = {}
    with open(dates_file) as f:
        for line in f:
            line = line.strip()
            if '|' in line:
                parts = line.split('|', 1)
                dates[parts[0].strip()] = parts[1].strip()
    return dates

def transform_frontmatter(content, title_suffix_strip=True, date=None, weight=None, url=None):
    """Transform YAML front matter in a Markdown file."""
    # Split front matter from content
    if not content.startswith('---'):
        return content

    end = content.find('\n---', 3)
    if end == -1:
        return content

    fm_text = content[3:end].strip()
    body = content[end+4:]

    # Parse front matter lines
    lines = fm_text.split('\n')
    new_lines = []

    for line in lines:
        # Strip | Sortie from title
        if title_suffix_strip and re.match(r'^title:', line):
            line = re.sub(r'\s*\|\s*Sortie\s*$', '', line)
        new_lines.append(line)

    # Add/update fields
    # Check if date already exists
    has_date = any(re.match(r'^date:', l) for l in new_lines)
    has_weight = any(re.match(r'^weight:', l) for l in new_lines)
    has_url = any(re.match(r'^url:', l) for l in new_lines)

    if date and not has_date:
        new_lines.append(f'date: {date}')
    if weight is not None and not has_weight:
        new_lines.append(f'weight: {weight}')
    if url and not has_url:
        new_lines.append(f'url: {url}')

    new_fm = '\n'.join(new_lines)
    return f'---\n{new_fm}\n---{body}'

def process_file(src, dst, creation_dates_key, date=None, weight=None, url=None):
    if date is None and creation_dates_key:
        date = DATES.get(creation_dates_key, '')

    with open(src, 'r', encoding='utf-8') as f:
        content = f.read()

    transformed = transform_frontmatter(content, date=date, weight=weight, url=url)

    os.makedirs(os.path.dirname(dst) if os.path.dirname(dst) else '.', exist_ok=True)
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(transformed)
    print(f"  {src} -> {dst} (date={date}, weight={weight}, url={url})")

# Load creation dates
DATES = load_creation_dates('/tmp/creation-dates.txt')

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'test'
    print(f"Mode: {mode}")
    print(f"Loaded {len(DATES)} creation dates")
    for k, v in list(DATES.items())[:3]:
        print(f"  {k} -> {v}")
