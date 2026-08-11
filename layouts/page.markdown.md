{{- /*
  Per-page Markdown mirror, published at <path>/index.md by the
  [outputFormats.Markdown] block in hugo.toml.

  Line 1 is the page title as an H1. .RawContent begins at the body, so without
  this the mirror would open with whatever the first body heading happens to be,
  and the title — which lives in front matter — would never appear at all.
  replaceRE collapses any embedded newline so a wrapped title stays one line.

  The second replaceRE rewrites site-absolute links to point at the sibling
  mirror rather than the HTML page: ](/reference/http-api/) becomes
  ](/reference/http-api/index.md), preserving any #fragment via the second
  capture group. An agent that follows links out of one mirror therefore stays
  in Markdown instead of falling back to 156 KB of HTML.

  Note what the regex does NOT match: it is anchored on "](/" so it only
  rewrites absolute links. A bare relative link such as ](http-api.md) passes
  through untouched and 404s, because every page in content/reference/ pins an
  explicit url: in front matter and so publishes at <path>/index.md, never at
  <path>.md. That defect was live for months and leaked into llms-full.txt.
  content/ now uses absolute links throughout; keep it that way, because this
  template cannot repair a relative one.

  The regex is also blind to whether the target actually HAS a mirror, and not
  every page does: [outputs] in hugo.toml gives Markdown to page only, so the
  home page and the four section index pages publish HTML alone. Rewriting a
  link to one of those manufactured a 404 — ](/reference/) became
  ](/reference/index.md), which is a URL Hugo never emits. That is the same
  dead-end-in-the-Markdown-graph failure as the ](http-api.md) defect above,
  arriving by the opposite route.

  So the loop below undoes the rewrite for every page that lacks the Markdown
  output format, leaving those links on the HTML URL, which resolves. It reads
  the output formats rather than hard-coding the five paths, so it stays correct
  if [outputs] changes or a new section is added. Undoing afterwards rather than
  excluding up front is deliberate: replaceRE cannot ask a question about the
  page a captured path belongs to.

  Why not the other fix — give sections a mirror by adding Markdown to the
  section and home outputs? Because .RawContent is the *source*, and the source
  of a section index is almost entirely {{< cards >}} shortcodes: unrendered,
  they are markup an agent cannot follow, and rendered they would be pure
  navigation. That would publish five files of chrome to satisfy one link, on a
  site whose Markdown surface exists precisely to be chrome-free. The HTML page
  those links now point at is the better artefact of the two.
*/ -}}
{{- $body := .RawContent | replaceRE `\]\((/[^)#]+/)(#[^)]*)?\)` "](${1}index.md${2})" -}}
{{- range site.Pages -}}
  {{- if not (.OutputFormats.Get "markdown") -}}
    {{- $body = replace $body (printf "](%sindex.md" .RelPermalink) (printf "](%s" .RelPermalink) -}}
  {{- end -}}
{{- end -}}
{{- .Title | replaceRE "\n" " " | printf "# %s" }}
{{ $body }}
