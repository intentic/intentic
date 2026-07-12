---
name: outline
description: Search, read, and create documents in your Outline wiki via the Outline API. Use when the user asks to find, read, or write Outline docs / knowledge base.
---

# Outline (connected)

Instance in `$OUTLINE_URL`, token in `$OUTLINE_API_KEY`. The Outline API is JSON POST for everything.
Headers: `-H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json"`. Base: `$OUTLINE_URL/api`.

- Who am I: `curl -s -X POST -H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json" "$OUTLINE_URL/api/auth.info" -d '{}' | jq '.data.user | {id, name}'`
- Search documents: `curl -s -X POST -H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json" "$OUTLINE_URL/api/documents.search" -d '{"query":"<QUERY>"}' | jq '.data[] | {id: .document.id, title: .document.title, context}'`
- Read a document: `curl -s -X POST -H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json" "$OUTLINE_URL/api/documents.info" -d '{"id":"<DOC_ID>"}' | jq '.data | {title, text}'`
- List collections: `curl -s -X POST -H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json" "$OUTLINE_URL/api/collections.list" -d '{}' | jq '.data[] | {id, name}'`
- Create a document: `curl -s -X POST -H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json" "$OUTLINE_URL/api/documents.create" -d '{"title":"...","text":"...","collectionId":"<COLLECTION_ID>","publish":true}'`
