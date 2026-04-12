{{- .Title | replaceRE "\n" " " | printf "# %s" }}
{{ .RawContent | replaceRE `\]\((/[^)#]+/)(#[^)]*)?\)` "](${1}index.md${2})" }}
