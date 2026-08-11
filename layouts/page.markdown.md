{{- $body := .RawContent | replaceRE `\]\((/[^)#]+/)(#[^)]*)?\)` "](${1}index.md${2})" -}}
{{- range site.Pages -}}
  {{- if not (.OutputFormats.Get "markdown") -}}
    {{- $body = replace $body (printf "](%sindex.md" .RelPermalink) (printf "](%s" .RelPermalink) -}}
  {{- end -}}
{{- end -}}
{{- .Title | replaceRE "\n" " " | printf "# %s" }}
{{ $body }}
