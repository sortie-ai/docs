# Mandatory Protocol for AI Agents

## Protocol

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Project Facts

This repository is the source of [docs.sortie-ai.com](https://docs.sortie-ai.com).

| Component | Value |
|---|---|
| Static site generator | Hugo ≥ 0.146.0, **extended** edition |
| Theme | Hextra v0.12.2, pulled as a Hugo Module (see `go.mod`) |
| Build output | `public/` (`publishDir` in `hugo.toml`) |
| Hosting | **Cloudflare Workers static assets** — not Cloudflare Pages |
| Deploy command | `npx wrangler deploy` — not `wrangler pages deploy` |
| Deploy config | `wrangler.toml`, `[assets] directory = "./public"` |

### Hosting: read this before touching deploy config

The site runs on Cloudflare **Workers**, using the static-assets binding. It was
migrated off Cloudflare Pages in commit `090d160`. Several older commit messages
still say "Pages" (for example `5cef252`), and comments elsewhere may too. Those
are stale. The authoritative signals, in order:

1. `wrangler.toml` has `[assets] directory` and **no** `pages_build_output_dir`.
   Pages projects have the latter.
2. `README.md` states the stack explicitly and gives `npx wrangler deploy`.

Cloudflare's own guidance is to start new projects on Workers rather than Pages;
Pages remains supported but receives no new feature investment.

### Per-page Markdown

Two representations. Both are live, and neither replaces the other.

1. **Static mirrors.** Every regular page publishes its Markdown source at
   `<path>/index.md` — 78 files — from `[outputFormats.Markdown]` in
   `hugo.toml` and the `layouts/page.markdown.md` template. They exist so that
   an agent can guess a URL rather than having to know about content
   negotiation. Note the shape: `<path>/index.md`, never `<path>.md`, because
   54 of the 83 content files pin an explicit `url:` in front matter and an
   explicit trailing-slash `url` overrides an output format's `ugly` setting.

   Every one of these files is served with `X-Robots-Tag: noindex, nofollow`
   by the `/*.md` rule in `static/_headers`. That header is the only thing
   keeping the mirrors out of the search index, and `static/robots.txt` must
   never `Disallow` them — a Disallow would block the agents they exist for
   *and* prevent Google from ever reading the `noindex`.

2. **Content negotiation.** Requesting the canonical page URL with
   `Accept: text/markdown` returns Markdown. That mechanism lives outside this
   repository — do not look for it in `layouts/` or `wrangler.toml`. It is what
   the "Copy page" context menu uses; see the comments above
   `[params.page.contextMenu]` in `hugo.toml` for the client-side half.

`/llms.txt` and `/llms-full.txt` are likewise generated at build time, by the
custom output formats declared at the bottom of `hugo.toml`. `/llms.txt`
follows <https://llmstxt.org/>; `/llms-full.txt` is a Mintlify convention and
is not in that specification.
