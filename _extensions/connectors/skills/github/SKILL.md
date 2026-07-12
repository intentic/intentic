---
name: github
description: Read and manage GitHub repos, issues, pull requests, and code search via the GitHub REST API. Use when the user asks about GitHub repos, issues, PRs, or code.
---

# GitHub (connected)

Token in `$GITHUB_TOKEN`. Talk to `https://api.github.com` with `curl`.
Headers: `-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json"`.

- Who am I: `curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | jq '{login}'`
- Your repos: `curl -s -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/user/repos?per_page=50&sort=updated" | jq '.[] | {full_name, private}'`
- Open issues in a repo: `curl -s -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/<OWNER>/<REPO>/issues?state=open" | jq '.[] | {number, title}'`
- Open pull requests: `curl -s -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/<OWNER>/<REPO>/pulls?state=open" | jq '.[] | {number, title}'`
- Search issues/PRs: `curl -s -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/search/issues?q=<URL_ENCODED_QUERY>" | jq '.items[] | {number, title, html_url}'`
- Create an issue: `curl -s -X POST -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/<OWNER>/<REPO>/issues" -d '{"title":"...","body":"..."}'`

## Git (clone / pull / push)
If this connection has git access enabled, https is credential-cached and ssh-form URLs work too (over a native
SSH key when the token could register one, otherwise transparently rerouted over https), so git needs no per-command auth:
- Clone: `git clone https://github.com/<OWNER>/<REPO>.git` (`ssh://git@github.com/<OWNER>/<REPO>.git` works too).
- Pull/push an existing repo (https or ssh clone): `git -C <REPO> pull` / `git -C <REPO> push`
- If native SSH is active, `ssh -T git@github.com` greets you; if it isn't, ssh-form URLs still pull/push over https.

Notes: paginate with `?per_page=100&page=N`. The token's scopes bound what you can reach.
