{{- $type := .Get "type" | default "default" -}}
{{- $label := cond (eq $type "default") "Note" (humanize $type) -}}
{{- $body := printf "**%s**\n\n%s" $label (trim .Inner "\n") -}}
{{- replaceRE `(?m)^> $` ">" (replaceRE `(?m)^` "> " $body) -}}
