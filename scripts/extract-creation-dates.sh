#!/usr/bin/env bash
# Extract the git creation date for each docs/ Markdown file.
# Output: docs/path/to/file.md|YYYY-MM-DD
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

find docs -name '*.md' -type f | sort | while read -r f; do
  created=$(git log --follow --diff-filter=A --format='%aI' -- "$f" | tail -1)
  if [[ -n "$created" ]]; then
    echo "${f}|${created%%T*}"
  else
    echo "WARNING: no creation date found for $f" >&2
  fi
done
