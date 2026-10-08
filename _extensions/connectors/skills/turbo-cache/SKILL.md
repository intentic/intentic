---
name: turbo-cache
description: Run turbo against the connected Turborepo remote cache, so a typecheck, build or test replays what CI already computed and hands CI what this sandbox checked. Use when running turbo tasks in a repository whose CI shares this cache, or when the user asks about the shared turbo cache.
---

# Turbo cache (connected)

The cache is at `$TURBO_CACHE_URL` (a credential-gateway address: the gateway adds the real token), with the team in
`$TURBO_CACHE_TEAM` (empty means `intentic`) and `$TURBO_CACHE_TOKEN` as the stand-in token turbo has to send.

Turbo reads its own variable names, so map them onto a run:

```sh
TURBO_API="$TURBO_CACHE_URL" TURBO_TOKEN="$TURBO_CACHE_TOKEN" TURBO_TEAM="${TURBO_CACHE_TEAM:-intentic}" \
  pnpm turbo run typecheck --filter=<package>
```

- Reads replay anything CI cached for the same inputs: a typecheck or build of an untouched package is a hit.
- Writes are task logs only. A cache server like the intentic repo's `_tools/turbo-cache` refuses an entry holding a
  build output with a 403, which turbo prints as a warning, and that is expected: the build's result is still yours.
- Is the cache up? `curl -s -H "Authorization: Bearer $TURBO_CACHE_TOKEN" "$TURBO_CACHE_URL/v8/artifacts/status"`
  answers `{"status":"enabled"}`.

In the intentic repository nothing needs doing by hand: the `turn` check `node _tools/turbo-cache/warm.mjs`
(`.intentic/checks.json`) sends each turn's typecheck passes when the turn ends, and CI's import step replays them.
