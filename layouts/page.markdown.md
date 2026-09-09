{{- $title := .Title | replaceRE "\n" " " -}}
{{- $body := .RenderShortcodes | replaceRE `\]\((/[^)#]+)/(#[^)]*)?\)` "](${1}.md${2})" -}}
{{- range site.Pages -}}
  {{- if not (.OutputFormats.Get "markdown") -}}
    {{- $body = replace $body (printf "](%s.md" (strings.TrimSuffix "/" .RelPermalink)) (printf "](%s" .RelPermalink) -}}
  {{- end -}}
{{- end -}}
{{ $title | printf "# %s" }}

> For the complete documentation index, see [llms.txt]({{ site.BaseURL }}llms.txt). Markdown versions of documentation pages are available by appending `.md` to the page URL.

{{ $body }}
