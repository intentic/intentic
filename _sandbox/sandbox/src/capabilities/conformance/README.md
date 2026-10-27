# Capability conformance

One scenario table checks a connection card against a local vendor fake and the real service.

The fake tier runs on every push. It loads the card from the real extension manifest, applies the real skill handler, builds the daemon's turn env, and runs bash, curl, jq and git through an in-process credential gateway. Git repositories are served by `git http-backend`. Origins are redirected only inside the injected gateway fetch and probe transport. Owner-terminal git uses a trusted local HTTPS CONNECT proxy, preserving github.com's credential lookup and the rewrites git-access wrote. No inherited credentials, proxy settings or git config enter a client command.

The live tier runs nightly under `INTENTIC_E2E_CAPABILITIES`, independently of the general `INTENTIC_E2E` sweep. Both worlds execute the exported `conformance` table. Consumed-field schemas parse the fake's fixtures and raw live responses alongside the jq output; missing fields, nulls and type changes fail. Lists must contain a row so an empty answer cannot falsely verify its item contract. Extra fields are allowed. This verifies the endpoints exercised by the scenarios, not the entire vendor API.

## Add a card

1. Add `<card>/<card>.fake.ts`, with only the endpoints its scenarios use. Reuse `@intentic/testing/http-fake`. Give consumed fields schemas and validate the fake's fixtures with them; use those same schemas on live answers.
2. Export `conformance: readonly Scenario<YourWorld>[]` from `<card>.conformance.ts`. Put assertions in that table, not in separate fake/live copies. Build a world with `kit/card`, `kit/gateway` and `kit/command`. API-only cards need no git or proxy helpers.
3. Mark writes with `writes: true` and `requiredSecrets` for their scratch target. Put optional account/tenant prerequisites in each scenario's `requiredSecrets`, not the card-wide secrets. Mark unsafe live scenarios with `fakeOnly` and a one-line reason. Never rely on a broker rule to keep a destructive live check safe.
4. Add thin `.conformance.integration.test.ts` and `.conformance.e2e.test.ts` files calling `registerConformance`. Pass behavior from other daemon subsystems into the world from these entry points. Use dedicated credentials, register cleanup before a write (by a unique name if its ID is not known yet), and keep failed cleanups available to `afterAll`. Use `kit/cleanup` for setup rollback and teardown; register scratch cleanup last so it runs before the gateway closes. Put known product failures or unconfirmed vendor behavior in a scenario's `todo`, which registers `test.todo`, and include evidence and what remains unverified.
5. Pass the card's secret names through turbo and the nightly capabilities job. Confirm its fake tier passes and its live tier names missing secrets when it stands down.

`skillCommand` extracts a command by its bullet label from the skill the daemon actually installed; its optional index selects another inline command on the same bullet. A missing label or unresolved placeholder fails. `skillCodeBlock` extracts a fenced helper by language and optional index from that installed skill, preserving the daemon's rewritten env names. Run the helper in the same shell as each command. For a write example, change only its payload to the scratch resource; keep the helper, verb, path and flags under test. Preserve the raw response before jq so missing fields cannot become null silently, and compare jq's projection with the parsed raw answer. `redirectedFetch` refuses every undeclared origin. `probeCapability` accepts a node-request transport because its normal transport does not use fetch. The workspace publish helper `created` is exported and accepts an injected fetch transport; production callers keep the defaults. No production URL or credential behavior changes.

## Run locally

From the repo root:

```sh
pnpm --filter @intentic/sandbox test github.conformance.integration
pnpm --filter @intentic/sandbox test cloudflare.conformance.integration
pnpm --filter @intentic/sandbox e2e:capabilities
# Root/CI entry point, including dependency builds:
pnpm e2e:capabilities
```

The fake tier requires bash, curl and jq; GitHub also requires git (including `git http-backend`), ssh-keygen and openssl. It uses temporary trees and free loopback ports, needs no network and removes its trees and listeners. Do not use an owner's connected card to unlock the live tier.

The conformance tree is excluded from production emission and included by `tsconfig.test.json`.

Commands use the daemon's bounded `runCheck` runner, which stops the whole process group at its deadline. CGI requests and replies use temporary files to preserve git's binary protocol through that text-oriented runner.

## GitHub nightly credentials

- `GITHUB_E2E_TOKEN`: a PAT of a dedicated test account, able to read its user and repository list and public issues. The account must have at least one visible repository so the repo item contract is exercised. A token alone runs probes, skill commands, agent git reads, owner-terminal git reads and restore; reads default to `octocat/Hello-World`.
- `GITHUB_E2E_REPO`: `owner/name` of a disposable, initialized scratch repo the token can read and push to, required only for writes. Enable issues and leave at least one open issue when using this repo, since the issues contract needs a row. Classic PAT: `repo`; fine-grained PAT: repository Metadata/Contents read and write, Issues read. No SSH-key administration is needed.

Writes create only UUID-named `intentic-conformance-*` branches. They never push the default branch. Each branch is removed in `finally`; `afterAll` retries outstanding cleanup. Owner-terminal push uses `--dry-run`. Account key calls use the existing injected git-access seam and never register a live key. Repository creation and a denied repository DELETE run only against the fake: either could damage account state if a guard broke. Missing token stands the card down; missing repo stands only writes down. Neither fails CI.

## Cloudflare nightly credentials

- `CLOUDFLARE_E2E_TOKEN`: a dedicated user API token with Account Settings Read (accounts), Zone Read (zones), and DNS Read on at least one visible zone containing a DNS record. Nightly falls back to its existing `CLOUDFLARE_API_TOKEN` secret. The token alone runs the declared probe, bad-token refusal, documented token/accounts/zones/DNS reads, refusal envelope, and absent-account fallback. List contracts require a row; grant access to actual resources rather than accepting empty lists as verification.
- `CLOUDFLARE_E2E_ACCOUNT_ID`: optional account ID, enabling Workers scripts and Pages projects reads. Add Workers Scripts Read and Pages Read permissions for that account and provision at least one Worker and one Pages project. The suite does not create either resource. Missing account ID stands only these scenarios down by name.
- `CLOUDFLARE_E2E_ZONE`: optional zone **name**, enabling writes. Give the token Zone Read and DNS Edit for this disposable scratch zone. Writes create one TXT record named `_intentic-conformance-<uuid>.<zone>`, update its content, delete it and list by name to confirm removal. They never change an existing record or zone settings. Cleanup is registered by name before creation; `finally` removes leftovers and `afterAll` retries failed cleanup before closing the gateway. Missing zone stands only writes down by name.

Do not set these variables locally from the owner's connected card. Development writes run only against the loopback fake. Zone, Worker and Pages deletion rules run only against the fake because a broken rule would destroy real resources. An unruled DNS DELETE is checked against a fake fixture record.

Cloudflare documents [user tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [account tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/), and separate verification routes: [`/user/tokens/verify`](https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/) and [`/accounts/{account_id}/tokens/verify`](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/). The manifest currently probes only the user route. The fake models both token types, but its account-token rejection on the user route is an explicit hypothesis: no account-owned token was available for a read-only observation during development. The expected successful account-token probe remains `test.todo` pending that observation and a probe design decision. No probe or manifest schema is changed.
