#!/usr/bin/env python3
"""
fix-links.py

Convert relative Markdown cross-links in content/ files to root-relative Hugo URLs.
Handles:
  - ../guides/slug.md   → /guides/slug/
  - ../reference/cli.md → /reference/cli/
  - ../concepts/slug.md → /concepts/slug/
  - ../getting-started/slug.md → /getting-started/slug/
  - same-dir: slug.md   → determined from slug-to-url map
  - image links: ../img/file.ext → /img/file.ext
"""
import os
import re
import glob
import sys

# Comprehensive slug → URL mapping (source basename → Hugo URL without trailing slash needed)
# These come from the migrate-content.py script assignments.

URL_MAP = {
    # Getting Started
    'installation': '/getting-started/installation/',
    'quick-start': '/getting-started/quick-start/',
    'jira-integration': '/getting-started/jira-integration/',
    'github-integration': '/getting-started/github-integration/',
    'jira-claude-end-to-end': '/getting-started/jira-claude-end-to-end/',
    'github-copilot-end-to-end': '/getting-started/github-copilot-end-to-end/',

    # Concepts
    'architecture': '/concepts/architecture/',
    'adapter-model': '/concepts/adapter-model/',
    'persistence': '/concepts/persistence/',
    'orchestration': '/concepts/orchestration/',
    'agent-communication': '/concepts/agent-communication/',
    'security': '/concepts/security/',
    'isolation': '/concepts/isolation/',

    # Reference core (flat URL override)
    'cli': '/reference/cli/',
    'workflow-config': '/reference/workflow-config/',
    'environment': '/reference/environment/',
    'http-api': '/reference/http-api/',
    'dashboard': '/reference/dashboard/',
    'prometheus-metrics': '/reference/prometheus-metrics/',
    'agent-extensions': '/reference/agent-extensions/',

    # Reference tracker-adapters
    'adapter-jira': '/reference/adapter-jira/',
    'adapter-github': '/reference/adapter-github/',

    # Reference agent-adapters
    'adapter-claude-code': '/reference/adapter-claude-code/',
    'adapter-copilot': '/reference/adapter-copilot/',

    # Reference core-reference
    'state-machine': '/reference/state-machine/',
    'errors': '/reference/errors/',

    # Guides (flat URL override)
    'connect-to-jira': '/guides/connect-to-jira/',
    'connect-to-github': '/guides/connect-to-github/',
    'use-file-adapter-for-testing': '/guides/use-file-adapter-for-testing/',
    'write-prompt-template': '/guides/write-prompt-template/',
    'setup-workspace-hooks': '/guides/setup-workspace-hooks/',
    'integrate-security-scanning': '/guides/integrate-security-scanning/',
    'run-multiple-workflows': '/guides/run-multiple-workflows/',
    'orchestrate-across-repositories': '/guides/orchestrate-across-repositories/',
    'configure-retry-behavior': '/guides/configure-retry-behavior/',
    'resume-sessions-across-restarts': '/guides/resume-sessions-across-restarts/',
    'control-costs': '/guides/control-costs/',
    'run-as-systemd-service': '/guides/run-as-systemd-service/',
    'run-as-launchctl-service': '/guides/run-as-launchctl-service/',
    'configure-ci-feedback': '/guides/configure-ci-feedback/',
    'scale-agents-with-ssh': '/guides/scale-agents-with-ssh/',
    'monitor-with-logs': '/guides/monitor-with-logs/',
    'monitor-with-prometheus': '/guides/monitor-with-prometheus/',
    'use-sortie-in-docker': '/guides/use-sortie-in-docker/',
    'deploy-sortie-to-kubernetes': '/guides/deploy-sortie-to-kubernetes/',
    'use-agent-tools-in-prompts': '/guides/use-agent-tools-in-prompts/',
    'use-subagents-with-sortie': '/guides/use-subagents-with-sortie/',
    'write-custom-agent-tool': '/guides/write-custom-agent-tool/',
    'troubleshoot-common-failures': '/guides/troubleshoot-common-failures/',

    # Changelog
    'changelog': '/changelog/',
}

def resolve_md_link(link_path):
    """
    Given a link path like ../guides/connect-to-jira.md or workflow-config.md#anchor,
    return the root-relative Hugo URL.
    """
    # Separate anchor
    anchor = ''
    if '#' in link_path:
        parts = link_path.split('#', 1)
        link_path = parts[0]
        anchor = '#' + parts[1]

    # Image links (../img/ or img/)
    if '/img/' in link_path or link_path.startswith('img/'):
        filename = link_path.split('/img/')[-1] if '/img/' in link_path else link_path[4:]
        return f'/img/{filename}{anchor}'

    # Strip leading path segments and .md suffix
    basename = os.path.basename(link_path)
    if basename.endswith('.md'):
        slug = basename[:-3]
    else:
        return None  # Not a .md link, skip

    url = URL_MAP.get(slug)
    if url:
        return url + anchor
    return None

# Link pattern: [text](path) — must be careful not to match ![img](path)
LINK_RE = re.compile(r'(?<!!)\[([^\]]*)\]\(([^)]+)\)')

def process_file(path, dry_run=False):
    with open(path, encoding='utf-8') as f:
        content = f.read()

    changes = 0
    new_content_parts = []
    last_end = 0

    for m in LINK_RE.finditer(content):
        link_text = m.group(1)
        link_path = m.group(2)
        full_match = m.group(0)

        # Only process relative .md links
        if link_path.startswith('http') or link_path.startswith('/'):
            continue
        if '.md' not in link_path and '/img/' not in link_path:
            continue

        new_url = resolve_md_link(link_path)
        if new_url and new_url != link_path:
            new_link = f'[{link_text}]({new_url})'
            new_content_parts.append(content[last_end:m.start()])
            new_content_parts.append(new_link)
            last_end = m.end()
            changes += 1

    if changes > 0:
        new_content_parts.append(content[last_end:])
        new_content = ''.join(new_content_parts)
        if not dry_run:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(new_content)
        print(f'  {path}: {changes} link(s) updated')

    return changes

def main():
    dry_run = '--dry-run' in sys.argv
    content_dir = os.path.join(os.path.dirname(__file__), '..', 'content')
    md_files = glob.glob(os.path.join(content_dir, '**', '*.md'), recursive=True)
    total = 0
    for f in sorted(md_files):
        c = process_file(f, dry_run=dry_run)
        total += c
    print(f'\nTotal links updated: {total}')
    if dry_run:
        print('(dry run — no files modified)')

if __name__ == '__main__':
    main()
