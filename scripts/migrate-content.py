#!/usr/bin/env python3
"""
migrate-content.py

Migrates all docs/ Markdown files to content/ with:
- Title suffix '| Sortie' stripped
- date: field added from git creation date
- weight: field added per spec §3.3.2
- url: field added for guides/ and reference/ (flat URL override)
"""
import os
import re
import shutil

DOCS_BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'docs'))
CONTENT_BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'content'))
DATES_FILE = '/tmp/creation-dates.txt'

def load_dates():
    dates = {}
    with open(DATES_FILE) as f:
        for line in f:
            line = line.strip()
            if '|' in line:
                parts = line.split('|', 1)
                dates[parts[0].strip()] = parts[1].strip()
    return dates

DATES = load_dates()

def get_date(docs_rel):
    """docs_rel: relative path like 'docs/getting-started/installation.md'"""
    return DATES.get(docs_rel, '')

def transform(content, date='', weight=None, url=None):
    if not content.startswith('---'):
        return content
    end = content.find('\n---', 3)
    if end == -1:
        return content
    fm_text = content[3:end].strip()
    body = content[end+4:]
    lines = fm_text.split('\n')
    new_lines = []
    for line in lines:
        if re.match(r'^title:', line):
            line = re.sub(r'\s*\|\s*Sortie\s*$', '', line)
        new_lines.append(line)
    if date:
        new_lines.append(f'date: {date}')
    if weight is not None:
        new_lines.append(f'weight: {weight}')
    if url:
        new_lines.append(f'url: {url}')
    return '---\n' + '\n'.join(new_lines) + '\n---' + body

def migrate(src_rel, dst_rel, weight, url=None):
    """src_rel and dst_rel are relative to their respective base dirs."""
    src = os.path.join(DOCS_BASE, src_rel)
    dst = os.path.join(CONTENT_BASE, dst_rel)
    date = get_date(f'docs/{src_rel}')
    with open(src, encoding='utf-8') as f:
        content = f.read()
    new_content = transform(content, date=date, weight=weight, url=url)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f'  docs/{src_rel} -> content/{dst_rel} (date={date}, weight={weight}{"," + url if url else ""})')

print('=== Migrating Getting Started ===')
migrations_gs = [
    ('getting-started/installation.md',              'getting-started/installation.md',              10),
    ('getting-started/quick-start.md',               'getting-started/quick-start.md',               20),
    ('getting-started/jira-integration.md',          'getting-started/jira-integration.md',          30),
    ('getting-started/github-integration.md',        'getting-started/github-integration.md',        40),
    ('getting-started/jira-claude-end-to-end.md',    'getting-started/jira-claude-end-to-end.md',    50),
    ('getting-started/github-copilot-end-to-end.md','getting-started/github-copilot-end-to-end.md', 60),
]
for src, dst, w in migrations_gs:
    migrate(src, dst, w)

print('\n=== Migrating Concepts ===')
migrations_concepts = [
    ('concepts/architecture.md',       'concepts/architecture.md',       10),
    ('concepts/adapter-model.md',      'concepts/adapter-model.md',      20),
    ('concepts/persistence.md',        'concepts/persistence.md',        30),
    ('concepts/orchestration.md',      'concepts/orchestration.md',      40),
    ('concepts/agent-communication.md','concepts/agent-communication.md',50),
    ('concepts/security.md',           'concepts/security.md',           60),
    ('concepts/isolation.md',          'concepts/isolation.md',          70),
]
for src, dst, w in migrations_concepts:
    migrate(src, dst, w)

print('\n=== Migrating Guides — setup ===')
migrations_guides_setup = [
    ('guides/connect-to-jira.md',                'guides/setup/connect-to-jira.md',                10, '/guides/connect-to-jira/'),
    ('guides/connect-to-github.md',              'guides/setup/connect-to-github.md',              20, '/guides/connect-to-github/'),
    ('guides/use-file-adapter-for-testing.md',   'guides/setup/use-file-adapter-for-testing.md',   30, '/guides/use-file-adapter-for-testing/'),
    ('guides/write-prompt-template.md',          'guides/setup/write-prompt-template.md',          40, '/guides/write-prompt-template/'),
    ('guides/setup-workspace-hooks.md',          'guides/setup/setup-workspace-hooks.md',          50, '/guides/setup-workspace-hooks/'),
    ('guides/integrate-security-scanning.md',    'guides/setup/integrate-security-scanning.md',    60, '/guides/integrate-security-scanning/'),
    ('guides/run-multiple-workflows.md',         'guides/setup/run-multiple-workflows.md',         70, '/guides/run-multiple-workflows/'),
    ('guides/orchestrate-across-repositories.md','guides/setup/orchestrate-across-repositories.md',80, '/guides/orchestrate-across-repositories/'),
    ('guides/configure-retry-behavior.md',       'guides/setup/configure-retry-behavior.md',       90, '/guides/configure-retry-behavior/'),
]
for src, dst, w, url in migrations_guides_setup:
    migrate(src, dst, w, url)

print('\n=== Migrating Guides — operations ===')
migrations_guides_ops = [
    ('guides/resume-sessions-across-restarts.md','guides/operations/resume-sessions-across-restarts.md',10, '/guides/resume-sessions-across-restarts/'),
    ('guides/control-costs.md',                  'guides/operations/control-costs.md',                  20, '/guides/control-costs/'),
    ('guides/run-as-systemd-service.md',         'guides/operations/run-as-systemd-service.md',         30, '/guides/run-as-systemd-service/'),
    ('guides/run-as-launchctl-service.md',        'guides/operations/run-as-launchctl-service.md',       40, '/guides/run-as-launchctl-service/'),
    ('guides/configure-ci-feedback.md',           'guides/operations/configure-ci-feedback.md',         50, '/guides/configure-ci-feedback/'),
    ('guides/scale-agents-with-ssh.md',           'guides/operations/scale-agents-with-ssh.md',         60, '/guides/scale-agents-with-ssh/'),
]
for src, dst, w, url in migrations_guides_ops:
    migrate(src, dst, w, url)

print('\n=== Migrating Guides — observability ===')
migrations_guides_obs = [
    ('guides/monitor-with-logs.md',      'guides/observability/monitor-with-logs.md',      10, '/guides/monitor-with-logs/'),
    ('guides/monitor-with-prometheus.md','guides/observability/monitor-with-prometheus.md',20, '/guides/monitor-with-prometheus/'),
]
for src, dst, w, url in migrations_guides_obs:
    migrate(src, dst, w, url)

print('\n=== Migrating Guides — deployment ===')
migrations_guides_dep = [
    ('guides/use-sortie-in-docker.md',       'guides/deployment/use-sortie-in-docker.md',       10, '/guides/use-sortie-in-docker/'),
    ('guides/deploy-sortie-to-kubernetes.md','guides/deployment/deploy-sortie-to-kubernetes.md',20, '/guides/deploy-sortie-to-kubernetes/'),
]
for src, dst, w, url in migrations_guides_dep:
    migrate(src, dst, w, url)

print('\n=== Migrating Guides — advanced ===')
migrations_guides_adv = [
    ('guides/use-agent-tools-in-prompts.md','guides/advanced/use-agent-tools-in-prompts.md',10, '/guides/use-agent-tools-in-prompts/'),
    ('guides/use-subagents-with-sortie.md', 'guides/advanced/use-subagents-with-sortie.md', 20, '/guides/use-subagents-with-sortie/'),
    ('guides/write-custom-agent-tool.md',   'guides/advanced/write-custom-agent-tool.md',   30, '/guides/write-custom-agent-tool/'),
]
for src, dst, w, url in migrations_guides_adv:
    migrate(src, dst, w, url)

print('\n=== Migrating Guides — troubleshooting ===')
migrations_guides_trbl = [
    ('guides/troubleshoot-common-failures.md','guides/troubleshooting/troubleshoot-common-failures.md',10, '/guides/troubleshoot-common-failures/'),
]
for src, dst, w, url in migrations_guides_trbl:
    migrate(src, dst, w, url)

print('\n=== Migrating Reference — core ===')
migrations_ref_core = [
    ('reference/cli.md',               'reference/core/cli.md',               10, '/reference/cli/'),
    ('reference/workflow-config.md',   'reference/core/workflow-config.md',   20, '/reference/workflow-config/'),
    ('reference/environment.md',       'reference/core/environment.md',       30, '/reference/environment/'),
    ('reference/http-api.md',          'reference/core/http-api.md',          40, '/reference/http-api/'),
    ('reference/dashboard.md',         'reference/core/dashboard.md',         50, '/reference/dashboard/'),
    ('reference/prometheus-metrics.md','reference/core/prometheus-metrics.md',60, '/reference/prometheus-metrics/'),
    ('reference/agent-extensions.md',  'reference/core/agent-extensions.md',  70, '/reference/agent-extensions/'),
]
for src, dst, w, url in migrations_ref_core:
    migrate(src, dst, w, url)

print('\n=== Migrating Reference — tracker-adapters ===')
migrations_ref_tracker = [
    ('reference/adapter-jira.md',  'reference/tracker-adapters/adapter-jira.md',  10, '/reference/adapter-jira/'),
    ('reference/adapter-github.md','reference/tracker-adapters/adapter-github.md',20, '/reference/adapter-github/'),
]
for src, dst, w, url in migrations_ref_tracker:
    migrate(src, dst, w, url)

print('\n=== Migrating Reference — agent-adapters ===')
migrations_ref_agent = [
    ('reference/adapter-claude-code.md','reference/agent-adapters/adapter-claude-code.md',10, '/reference/adapter-claude-code/'),
    ('reference/adapter-copilot.md',    'reference/agent-adapters/adapter-copilot.md',    20, '/reference/adapter-copilot/'),
]
for src, dst, w, url in migrations_ref_agent:
    migrate(src, dst, w, url)

print('\n=== Migrating Reference — core-reference ===')
migrations_ref_coreref = [
    ('reference/state-machine.md','reference/core-reference/state-machine.md',10, '/reference/state-machine/'),
    ('reference/errors.md',       'reference/core-reference/errors.md',       20, '/reference/errors/'),
]
for src, dst, w, url in migrations_ref_coreref:
    migrate(src, dst, w, url)

print('\n=== Migrating Changelog ===')
migrate('changelog.md', 'changelog.md', 5)

print('\nDone!')
