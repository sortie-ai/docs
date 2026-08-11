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
*/ -}}
{{- .Title | replaceRE "\n" " " | printf "# %s" }}
{{ .RawContent | replaceRE `\]\((/[^)#]+/)(#[^)]*)?\)` "](${1}index.md${2})" }}
