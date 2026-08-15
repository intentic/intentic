---
name: notion
description: Search, read, create and update pages and databases in your Notion workspace via the Notion API. Use when the user asks to find, read, or write Notion pages, notes, docs, or database rows.
---

# Notion (connected)

Token in `$NOTION_TOKEN`. Base is `https://api.notion.com/v1`, and every call carries three headers, so define
this helper once per shell — `notion <METHOD> <path> [-d '<json>']`:

```sh
notion() { local m="$1" p="$2"; shift 2; curl -s -X "$m" -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" -H "Content-Type: application/json" \
  "https://api.notion.com/v1/$p" "$@"; }
```

The integration only sees pages and databases someone shared with it (page `•••` → `Connections`); sub-pages
inherit. **A 404 (`object_not_found`) therefore usually means "not shared", not "does not exist"** — report it
that way and ask the user to share the page rather than concluding it is gone.

- Who am I: `notion GET users/me | jq '{name, workspace: .bot.workspace_name}'`
- Search — titles only, across everything shared: `notion POST search -d '{"query":"<QUERY>","page_size":20}' | jq -c '.results[] | {id, object, url}'` (add `"filter":{"property":"object","value":"page"}` — or `"value":"database"` — to narrow; an empty query lists everything shared)
- A page's title: `notion GET pages/<PAGE_ID> | jq -r '[.properties[] | select(.type=="title") | .title[].plain_text] | join("")'`
- Read a page's content: `notion GET "blocks/<PAGE_ID>/children?page_size=100" | jq -c '.results[] | {id, type, has_children, text: ([.[.type].rich_text[]?.plain_text] | join(""))}'` — a block with `has_children: true` (toggle, sub-page, column) needs its own `blocks/<BLOCK_ID>/children` call
- Create a page: `notion POST pages -d '{"parent":{"page_id":"<PAGE_ID>"},"properties":{"title":{"title":[{"text":{"content":"<TITLE>"}}]}},"children":[{"object":"block","type":"paragraph","paragraph":{"rich_text":[{"text":{"content":"..."}}]}}]}'`
- Append content to a page: `notion PATCH "blocks/<PAGE_ID>/children" -d '{"children":[...]}'` — same block shapes; useful types: `paragraph`, `heading_1`/`2`/`3`, `bulleted_list_item`, `numbered_list_item`, `to_do` (plus `"checked":false`), `quote`, `divider` (empty `{}`), `code` (plus `"language":"python"`)
- A database's schema — the property names and types rows must match: `notion GET databases/<DB_ID> | jq '.properties | map_values(.type)'`
- Query a database: `notion POST "databases/<DB_ID>/query" -d '{"page_size":100}' | jq -c '.results[] | {id, url, props: (.properties | map_values(.[.type]))}'` — filter/sort in the body, e.g. `{"filter":{"property":"Status","select":{"equals":"Done"}},"sorts":[{"timestamp":"last_edited_time","direction":"descending"}]}`
- Add a database row: `notion POST pages -d '{"parent":{"database_id":"<DB_ID>"},"properties":{"Name":{"title":[{"text":{"content":"..."}}]},"Status":{"select":{"name":"In progress"}}}}'` — property keys are the schema's names, exactly
- Update page properties: `notion PATCH pages/<PAGE_ID> -d '{"properties":{...}}'` · move to trash: `-d '{"archived":true}'`
- Comment on a page: `notion POST comments -d '{"parent":{"page_id":"<PAGE_ID>"},"rich_text":[{"text":{"content":"..."}}]}'` · read comments: `notion GET "comments?block_id=<PAGE_ID>"`

Notes: an id is the 32 hex chars at the end of any Notion URL — hyphenated or not, both accepted, so users can
paste links. Search matches **titles only**; to find something by body text, read the likely pages. Paginate
with `has_more`/`next_cursor` → `start_cursor` (query param on GETs, body field on POSTs). One append call takes
at most 100 blocks and one rich-text item at most 2000 characters — chunk long writes. Rate limit averages 3
requests/second; on 429 honour `Retry-After`. Errors come as JSON `{code, message}` — quote `message` when
reporting, and remember `object_not_found` most often means unshared.
