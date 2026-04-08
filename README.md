<div align="center">

# Sortie Documentation

**Source for [docs.sortie-ai.com](https://docs.sortie-ai.com)**

Sortie turns issue tracker tickets into autonomous coding agent sessions.
This repository contains all the source code and content for the Sortie documentation site.

[Read the Docs](https://docs.sortie-ai.com) · [Report an Issue](https://github.com/sortie-ai/sortie-docs/issues/new) · [Main Repository](https://github.com/sortie-ai/sortie)

</div>

---

## About Sortie

Sortie is an autonomous coding agent orchestrator. Engineers manage work at the ticket level — Sortie handles the rest: isolated workspaces, retry logic, state reconciliation, tracker integration, and cost tracking. Single binary, zero dependencies, SQLite persistence.

For a full overview, see the [product documentation](https://docs.sortie-ai.com).

## Tech Stack

| Component | Details |
|---|---|
| **Static site generator** | [Hugo](https://gohugo.io/) ≥ 0.146.0 (extended) |
| **Theme** | [Hextra](https://imfing.github.io/hextra/) (Tailwind CSS, FlexSearch) |
| **Markdown renderer** | Goldmark with KaTeX math support |
| **Deployment** | [Cloudflare Workers](https://developers.cloudflare.com/workers/) (static assets via Wrangler) |
| **Analytics** | Google Analytics GA4 with GDPR-compliant cookie consent |

## Prerequisites

- [Hugo](https://gohugo.io/installation/) ≥ 0.146.0 **extended** version
- [Git](https://git-scm.com/) — required for `enableGitInfo` (last-modified dates)
- [Node.js](https://nodejs.org/) — required for Wrangler deployment

## Local Development

Clone the repository (including the Hextra theme submodule) and start the dev server:

```bash
git clone --recurse-submodules https://github.com/sortie-ai/sortie-docs.git
cd sortie-docs

hugo server   # dev server at http://localhost:1313
```

Open [http://localhost:1313](http://localhost:1313) in your browser. Hugo watches for file changes and reloads automatically.

### Build for Production

```bash
hugo   # outputs to public/
```

The generated static site in `public/` is deployed to Cloudflare Workers via Wrangler:

```bash
npx wrangler deploy
```

## Repository Structure

```
sortie-docs/
├── content/                     # All documentation content (Markdown)
│   ├── _index.md                # Homepage
│   ├── changelog.md             # Release history
│   ├── concepts/                # Conceptual explanations
│   ├── getting-started/         # Installation, Quick Start, Jira Integration, End-to-End
│   ├── guides/                  # How-to guides (SSH scaling, monitoring, hooks, etc.)
│   └── reference/               # CLI, Workflow config, API, Prometheus metrics, errors
├── layouts/                     # Hugo layout overrides (Go templates)
├── static/                      # Static assets
│   ├── img/                     # Images, favicons, OG image
│   ├── css/                     # Custom CSS (cookieconsent, overrides)
│   ├── js/                      # Custom JS (feedback widget, cookie consent)
│   ├── _headers                 # Cloudflare response headers
│   └── _redirects               # URL redirects
├── themes/hextra/               # Hextra theme (git submodule)
├── hugo.toml                    # Hugo configuration
├── wrangler.toml                # Cloudflare Workers deployment config
└── package.json                 # Node.js deps (Wrangler)
```

## Contributing

We welcome contributions from the community — whether it's fixing a typo, improving a guide, or adding new content.

### Quick Edits

For small fixes (typos, broken links, wording improvements), edit the file directly on GitHub and open a Pull Request.

### Adding a Page

1. Create a new `.md` file in the appropriate `content/` subdirectory.
2. Hugo picks it up automatically — no nav registration required.
3. Preview locally with `hugo server`.
4. Push your branch — Cloudflare deploys automatically on merge to `main`.

### Content Guidelines

- Documentation follows the [Diátaxis framework](https://diataxis.fr/) — tutorials, how-to guides, reference, and explanation are kept separate by intent.
- Write in clear, concise English aimed at senior engineers and DevOps practitioners.
- Use [Hextra callout shortcodes](https://imfing.github.io/hextra/docs/guide/shortcodes/callout/) for warnings, tips, and notes.
- Include cross-links to related pages (installation → quick start → reference).
- Every page should have `title` and `description` in its front matter.

## Related

| Link | Description |
|---|---|
| [sortie-ai/sortie](https://github.com/sortie-ai/sortie) | Main project — the Sortie orchestrator binary |
| [sortie-ai/homebrew-tap](https://github.com/sortie-ai/homebrew-tap) | Homebrew Tap for Sortie |
| [Architecture spec](https://github.com/sortie-ai/sortie/blob/main/docs/architecture.md) | Internal engineering reference |

## License

Documentation text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Code examples and configuration samples are licensed under [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0).

See [LICENSE](LICENSE) for full details.
