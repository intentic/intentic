---
name: sharepoint
description: Read and write SharePoint sites, document libraries, files and lists through Microsoft Graph. Use when the user asks about SharePoint sites, team documents, shared files, or SharePoint lists.
---

# SharePoint (connected)

App-only access through Microsoft Graph. Credentials in `$SHAREPOINT_TENANT_ID`, `$SHAREPOINT_CLIENT_ID` and
`$SHAREPOINT_CLIENT_SECRET`; `$SHAREPOINT_HOSTNAME` may hold the tenant's host (`contoso.sharepoint.com`).
There is no user behind this token: it is the app itself, so "my files" / OneDrive personal drives are out of
reach and `/me` always fails. Get an hour-long token, then call Graph with it:

```sh
sp_token() { curl -s -X POST "https://login.microsoftonline.com/$SHAREPOINT_TENANT_ID/oauth2/v2.0/token" \
  -d "client_id=$SHAREPOINT_CLIENT_ID" -d "client_secret=$SHAREPOINT_CLIENT_SECRET" \
  -d "scope=https://graph.microsoft.com/.default" -d "grant_type=client_credentials" | jq -r '.access_token'; }
SP=$(sp_token)   # re-run when calls start answering 401 (the token lasts ~1 hour)
sp() { local m="$1" p="$2"; shift 2; curl -s -X "$m" -H "Authorization: Bearer $SP" \
  -H "Content-Type: application/json" "https://graph.microsoft.com/v1.0/$p" "$@"; }
```

If `sp_token` answers no token, print the body: it comes back as `{error, error_description}` and the
description spells the cause out in words, `AADSTS…` code and all: quote it rather than guessing from the short
`error` alone. A 403 on a call that looks right is almost always the
missing piece from setup: admin consent was never granted, or the app has `Sites.Selected` and nobody granted it
this site. Say that rather than "the site does not exist".

- Find sites: `sp GET "sites?search=<TERM>" | jq -c '.value[] | {id, name, webUrl}'` (root site: `sp GET sites/root`)
- A site by URL path: `sp GET "sites/$SHAREPOINT_HOSTNAME:/sites/<SITE>" | jq '{id, displayName, webUrl}'`
- Subsites: `sp GET "sites/<SITE_ID>/sites" | jq -c '.value[] | {id, name, webUrl}'`
- Document libraries: `sp GET "sites/<SITE_ID>/drives" | jq -c '.value[] | {id, name, webUrl}'`, the default one is `sp GET "sites/<SITE_ID>/drive"`
- Browse a library: `sp GET "drives/<DRIVE_ID>/root/children" | jq -c '.value[] | {id, name, size, folder: (.folder != null), lastModifiedDateTime}'` · a subfolder: `sp GET "drives/<DRIVE_ID>/root:/<FOLDER PATH>:/children"`
- Find files in a library: `sp GET "drives/<DRIVE_ID>/root/search(q='<TERM>')" | jq -c '.value[] | {id, name, webUrl}'`
- Download a file: `curl -sL -H "Authorization: Bearer $SP" "https://graph.microsoft.com/v1.0/drives/<DRIVE_ID>/items/<ITEM_ID>/content" -o <FILE>`, `-L`, because Graph redirects to storage
- Upload a file (under 4 MB): `curl -s -X PUT -H "Authorization: Bearer $SP" --data-binary @<FILE> "https://graph.microsoft.com/v1.0/drives/<DRIVE_ID>/root:/<FOLDER>/<NAME>:/content" | jq '{id, name, webUrl}'`, larger files need an upload session (`.../createUploadSession`)
- Create a folder: `sp POST "drives/<DRIVE_ID>/root/children" -d '{"name":"<NAME>","folder":{},"@microsoft.graph.conflictBehavior":"rename"}'`
- Lists on a site: `sp GET "sites/<SITE_ID>/lists" | jq -c '.value[] | {id, name, template: .list.template}'`, `documentLibrary` templates are the libraries above, seen from the list side
- A list's columns: `sp GET "sites/<SITE_ID>/lists/<LIST_ID>/columns" | jq -c '.value[] | {name, displayName, readOnly}'`
- List rows: `sp GET "sites/<SITE_ID>/lists/<LIST_ID>/items?expand=fields&\$top=100" | jq -c '.value[] | {id, fields}'`, without `expand=fields` the rows come back empty of content
- Add a row: `sp POST "sites/<SITE_ID>/lists/<LIST_ID>/items" -d '{"fields":{"Title":"...","Status":"Open"}}'`, keys are the columns' internal `name`s, not their display names
- Update / delete a row: `sp PATCH "sites/<SITE_ID>/lists/<LIST_ID>/items/<ITEM_ID>/fields" -d '{"Status":"Done"}'` · `sp DELETE "sites/<SITE_ID>/lists/<LIST_ID>/items/<ITEM_ID>"`

Notes: a site id is a comma-joined triple (`contoso.sharepoint.com,<guid>,<guid>`), ugly but ordinary, pass it
whole. Escape `$` in Graph's own query params inside double quotes (`\$top`, `\$select`, `\$filter`) or the shell
eats them. Page with `.["@odata.nextLink"]`, which is a full URL: call it directly with the bearer header.
Errors arrive as `{error: {code, message}}`; quote the `message`. Writes land as the app, not as a person, and
show in version history as such: say what you are about to change before changing shared documents.
