{{- $title := .Title | replaceRE "\n" " " -}}
{{- $body := .RenderShortcodes | replaceRE `\]\((/[^)#]+/)(#[^)]*)?\)` "](${1}index.md${2})" -}}
{{- range site.Pages -}}
  {{- if not (.OutputFormats.Get "markdown") -}}
    {{- $body = replace $body (printf "](%sindex.md" .RelPermalink) (printf "](%s" .RelPermalink) -}}
  {{- end -}}
{{- end -}}
---
title: {{ $title | jsonify }}
url: {{ .Permalink | jsonify }}
{{- with .Description }}
description: {{ . | jsonify }}
{{- end }}
{{- if not .Date.IsZero }}
date: {{ .Date.Format "2006-01-02" }}
{{- end }}
---

{{ $title | printf "# %s" }}
{{ $body }}
