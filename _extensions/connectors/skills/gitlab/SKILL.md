---
name: gitlab
description: Read and manage GitLab projects, issues, merge requests, and pipelines via the GitLab REST API. Use when the user asks about GitLab projects, issues, MRs, or pipelines.
---

# GitLab (connected)

Token in `$GITLAB_TOKEN`, instance base in `$GITLAB_URL`. Talk to `$GITLAB_URL/api/v4` with `curl`.
Header: `-H "PRIVATE-TOKEN: $GITLAB_TOKEN"`.

- Who am I: `curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/user" | jq '{username}'`
- Your projects: `curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects?membership=true&per_page=50" | jq '.[] | {id, path_with_namespace}'`
- Open issues: `curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/<ID>/issues?state=opened" | jq '.[] | {iid, title}'`
- Open merge requests: `curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/<ID>/merge_requests?state=opened" | jq '.[] | {iid, title}'`
- Recent pipelines: `curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/<ID>/pipelines?per_page=10" | jq '.[] | {id, status, ref}'`
- Create an issue: `curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/<ID>/issues" --data-urlencode "title=..."`

## Git (clone / pull / push)
If this connection has git access enabled, https is credential-cached and ssh-form URLs work too (over a native
SSH key when the token could register one, otherwise transparently rerouted over https), so git needs no per-command
auth (host = $GITLAB_URL without the scheme):
- Clone: `git clone $GITLAB_URL/<GROUP>/<REPO>.git` (`ssh://git@<GITLAB_HOST>/<GROUP>/<REPO>.git` works too).
- Pull/push an existing repo (https or ssh clone): `git -C <REPO> pull` / `git -C <REPO> push`
- If native SSH is active, `ssh -T git@<GITLAB_HOST>` greets you; if it isn't, ssh-form URLs still work over https.

Notes: `<ID>` is the numeric project id (from the projects list) or a URL-encoded path (group%2Frepo). Self-hosted works — $GITLAB_URL points at your instance.
