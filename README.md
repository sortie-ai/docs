# Sortie Documentation

Source for [docs.sortie-ai.com](https://docs.sortie-ai.com).

Built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/),
deployed to [Cloudflare Workers](https://developers.cloudflare.com/workers/).

## Local development

```bash
asdf install        # Python via .tool-versions
uv sync             # install dependencies
uv run mkdocs serve # http://127.0.0.1:8000
```

## Adding a page

1. Create `.md` file in `docs/`
2. Add to `nav` in `mkdocs.yml`
3. Preview locally, push, Cloudflare deploys on merge to `main`

## Adding a plugin

```bash
uv add <plugin-name>
uv export --no-hashes --no-dev -o requirements.txt
# Add plugin to mkdocs.yml → plugins
```

## Related

- [sortie-ai/sortie](https://github.com/sortie-ai/sortie) — main project
- [Architecture spec](https://github.com/sortie-ai/sortie/blob/main/docs/architecture.md) — internal engineering reference
