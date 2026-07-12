---
name: sentry
description: Query Sentry organizations, projects, and unresolved issues/errors via the Sentry API. Use when the user asks about Sentry errors, issues, or projects.
---

# Sentry (connected)

Token in `$SENTRY_TOKEN`, base in `$SENTRY_URL`, org slug in `$SENTRY_ORG` (may be empty). Talk to `$SENTRY_URL/api/0` with `curl`.
Header: `-H "Authorization: Bearer $SENTRY_TOKEN"`.

- If `$SENTRY_ORG` is empty, list orgs first and use a slug below:
  `curl -s -H "Authorization: Bearer $SENTRY_TOKEN" "$SENTRY_URL/api/0/organizations/" | jq '.[] | {slug, name}'`
- List projects: `curl -s -H "Authorization: Bearer $SENTRY_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/projects/" | jq '.[] | {slug, platform}'`
- Unresolved issues: `curl -s -H "Authorization: Bearer $SENTRY_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved&limit=25" | jq '.[] | {shortId, title, count, culprit}'`
- Latest event for an issue: `curl -s -H "Authorization: Bearer $SENTRY_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/issues/<ISSUE_ID>/events/latest/" | jq '{eventID, message}'`

Notes: SaaS base is https://sentry.io (or a region host like https://us.sentry.io); self-hosted uses your instance URL.
