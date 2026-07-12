---
name: redmine
description: Read and manage Redmine projects, issues, and updates via the Redmine REST API. Use when the user asks about Redmine tickets/issues or projects.
---

# Redmine (connected)

Instance in `$REDMINE_URL`, API key in `$REDMINE_API_KEY`. Talk to `$REDMINE_URL` with `curl`.
Header: `-H "X-Redmine-API-Key: $REDMINE_API_KEY"`.

- Who am I: `curl -s -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/users/current.json" | jq '.user | {id, login}'`
- Projects: `curl -s -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/projects.json" | jq '.projects[] | {id, identifier, name}'`
- Open issues: `curl -s -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/issues.json?status_id=open&limit=50" | jq '.issues[] | {id, subject, status: .status.name}'`
- One issue: `curl -s -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/issues/<ID>.json" | jq '.issue | {id, subject, description}'`
- Create an issue: `curl -s -X POST -H "X-Redmine-API-Key: $REDMINE_API_KEY" -H "Content-Type: application/json" -d '{"issue":{"project_id":<PID>,"subject":"...","description":"..."}}' "$REDMINE_URL/issues.json"`
- Update an issue: `curl -s -X PUT -H "X-Redmine-API-Key: $REDMINE_API_KEY" -H "Content-Type: application/json" -d '{"issue":{"notes":"...","status_id":<SID>}}' "$REDMINE_URL/issues/<ID>.json"`
