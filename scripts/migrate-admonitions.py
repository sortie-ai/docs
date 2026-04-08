#!/usr/bin/env python3
"""
migrate-admonitions.py

Converts MkDocs !!! admonition blocks in content/ to:
  - Untitled admonitions → GFM alerts  (> [!TYPE])
  - Titled admonitions   → Hextra callout shortcodes ({{< callout type="..." >}})

Per spec §3.4.1.

Type mapping:
  note, info, abstract, summary → NOTE / callout info
  tip, hint                     → TIP  / callout info
  warning, caution              → WARNING / callout warning
  danger, failure, fail, error, bug → CAUTION / callout error
  success, check, example, quote    → NOTE / callout default
  important                         → IMPORTANT / callout important
"""
import os
import re
import glob
import sys

GFM_MAP = {
    'note': 'NOTE', 'info': 'NOTE', 'abstract': 'NOTE', 'summary': 'NOTE',
    'tip': 'TIP', 'hint': 'TIP',
    'warning': 'WARNING', 'caution': 'WARNING',
    'danger': 'CAUTION', 'failure': 'CAUTION', 'fail': 'CAUTION',
    'error': 'CAUTION', 'bug': 'CAUTION',
    'success': 'NOTE', 'check': 'NOTE', 'example': 'NOTE', 'quote': 'NOTE',
    'important': 'IMPORTANT',
}

CALLOUT_MAP = {
    'note': 'info', 'info': 'info', 'abstract': 'info', 'summary': 'info',
    'tip': 'info', 'hint': 'info',
    'warning': 'warning', 'caution': 'warning',
    'danger': 'error', 'failure': 'error', 'fail': 'error',
    'error': 'error', 'bug': 'error',
    'success': 'default', 'check': 'default', 'example': 'default', 'quote': 'default',
    'important': 'important',
}

ALL_TYPES = '|'.join(GFM_MAP.keys())
UNTITLED_RE = re.compile(r'^!!! (' + ALL_TYPES + r')\s*$', re.IGNORECASE)
TITLED_RE   = re.compile(r'^!!! (' + ALL_TYPES + r') "([^"]+)"\s*$', re.IGNORECASE)
INDENTED_RE = re.compile(r'^    (.*)$')

def extract_admonition_body(lines, start):
    """
    Starting at start (the line after !!! header), extract contiguous 4-space indented lines.
    Returns (body_lines_stripped, end_index) where end_index is the first line NOT part of body.
    """
    body = []
    i = start
    while i < len(lines):
        line = lines[i]
        m = INDENTED_RE.match(line)
        if m:
            body.append(m.group(1))
            i += 1
        elif line.strip() == '' and i + 1 < len(lines) and INDENTED_RE.match(lines[i + 1]):
            # blank line between indented paragraphs — keep blank
            body.append('')
            i += 1
        else:
            break
    return body, i

def convert_line_group(lines):
    """Converts admonitions in a list of text lines. Returns new lines and count of conversions."""
    result = []
    i = 0
    conversions = 0
    while i < len(lines):
        line = lines[i]

        # Check titled first (more specific)
        m_titled = TITLED_RE.match(line)
        m_untitled = UNTITLED_RE.match(line) if not m_titled else None

        if m_titled or m_untitled:
            if m_titled:
                admon_type = m_titled.group(1).lower()
                title = m_titled.group(2)
            else:
                admon_type = m_untitled.group(1).lower()
                title = None

            body, next_i = extract_admonition_body(lines, i + 1)

            if not body:
                # No indented body found — leave as-is (shouldn't happen in valid admonitions)
                result.append(line)
                i += 1
                continue

            conversions += 1

            if title:
                # Titled → callout shortcode
                callout_type = CALLOUT_MAP.get(admon_type, 'info')
                result.append(f'{{{{< callout type="{callout_type}" >}}}}')
                result.append(f'**{title}**')
                result.append('')
                result.extend(body)
                result.append('{{< /callout >}}')
            else:
                # Untitled → GFM alert
                gfm_type = GFM_MAP.get(admon_type, 'NOTE')
                first = True
                for bline in body:
                    if first:
                        result.append(f'> [!{gfm_type}]')
                        first = False
                    result.append(f'> {bline}'.rstrip())
            i = next_i
        else:
            result.append(line)
            i += 1

    return result, conversions

def process_file(path, dry_run=False):
    with open(path, encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')
    new_lines, count = convert_line_group(lines)

    if count > 0:
        if not dry_run:
            # Write backup
            with open(path + '.bak', 'w', encoding='utf-8') as f:
                f.write(content)
            # Write converted
            with open(path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(new_lines))
        print(f'  {path}: {count} conversion(s)')

    return count

def main():
    dry_run = '--dry-run' in sys.argv
    content_dir = os.path.join(os.path.dirname(__file__), '..', 'content')
    md_files = glob.glob(os.path.join(content_dir, '**', '*.md'), recursive=True)
    total = 0
    for f in sorted(md_files):
        c = process_file(f, dry_run=dry_run)
        total += c
    print(f'\nTotal conversions: {total}')
    if dry_run:
        print('(dry run — no files modified)')

if __name__ == '__main__':
    main()
