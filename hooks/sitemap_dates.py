"""MkDocs hook: set page.update_date from git revision date plugin."""


def on_page_context(context, page, config, nav):
    date = page.meta.get("git_revision_date_localized_raw_iso_date")
    if date:
        page.update_date = date
