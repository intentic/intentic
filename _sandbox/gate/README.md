# @intentic/gate

The one-line CI step for a release gate: POSTs what the pipeline knows to a gated workflow's webhook, waits for the run, and exits on the verdict.

## Responsibilities

A gated workflow (see `_sandbox/sandbox`, gate.routes.ts) already answers a bare `curl`: POST the request, hold
the connection, read `{outcome, reason, runId}` back. What every team then writes around that curl is the same
six lines of shell: map `pass`/`fail`/`blocked` to exit codes, print the reason where the log will show it,
keep the client's timeout longer than the server's hold. This package is those six lines, written once:

```sh
npx @intentic/gate "commit $SHA on $BRANCH — preview at $URL"
```

- `pass` exits 0, `fail` exits 1.
- `blocked` (the gate could not judge) exits 0 by default, because "the check broke" must not read as "the
  product broke". `--blocked <code>` points it at a real neutral where the CI system has one.
- Exit 2 is never a verdict: it means the exchange itself failed (wrong token, no such gate, the daily run
  ceiling, network), which needs the pipeline's owner rather than the product's.

The URL (token and all) comes from `--url` or the `INTENTIC_GATE_URL` environment variable: the shape every
CI secret store hands things over in. On the wire the token leaves the URL: it is sent as `authorization:
Bearer …`, so the address that reaches the edge, the tunnel and every proxy's log names the door and nothing
else (`dialOf`). The request is the arguments joined, or stdin when none are given. The
`--wait` deadline (default 1800 s) rides to the server, and the HTTP client waits a minute longer, so the
deadline that fires is the server's: which stops the run instead of abandoning it mid-spend.

## Driving the agent: `intentic-gate run`

The same binary's second exchange, and not a door: with a control token minted on **Sandbox → Access → API
tokens** (`drive` scope, or `land` to merge as well) it starts an agent turn at the sandbox's own address, polls
the agent's card until it settles, and exits on how it ended:

```sh
INTENTIC_URL=https://sandbox-….intentic.dev INTENTIC_TOKEN=ict_… \
  npx @intentic/gate run --land "fix the flaky test in ci and open the diff"
```

- `completed` exits 0; `parked` (the agent asked a person for something) and `failed` exit 1, with the card's
  own sentence; `timeout` exits 2, the deadline decided and the agent keeps working in the sandbox.
- One conversation per CI run and attempt (`--conversation` to pin one), its own branch, landed only with
  `--land`. `--agent` picks the runtime, `--wait` the patience.

[src/run.ts](src/run.ts) is that exchange as pure functions plus `runExchange` with its effects injected, so the
CLI here and the Marketplace action share one implementation and [src/run.test.ts](src/run.test.ts) drives it
against a scripted daemon.

## Pipeline templates

GitHub Actions has a step of its own: the Marketplace action (`_sandbox/gate-action`), which wraps this
package's exchange and composes the request from the workflow's context:

```yaml
- name: Release gate
  uses: intentic/gate-action@v1
  with:
    url: ${{ secrets.INTENTIC_GATE_URL }}
```

GitLab CI, `allow_failure: exit_codes` is a real neutral, so `blocked` can have its own colour:

```yaml
release-gate:
  image: node:24-alpine
  script:
    - npx --yes @intentic/gate --blocked 3 "commit $CI_COMMIT_SHA on $CI_COMMIT_REF_NAME"
  allow_failure:
    exit_codes: [3]
```

## How it fits

The gate route is the daemon's door for a caller with no identity; the designer's gate panel (the workflows
extension) is where a gate is declared and its URL copied. This package is the third leg: the caller's side of
the exchange, distributed on npm so a pipeline runs it cold with `npx`. On GitHub specifically the same
exchange wears Marketplace clothes: `@intentic/gate-action` bundles this package's pure functions into the
`intentic/gate-action` action: and every other CI system runs this CLI. It deliberately depends on nothing:
every dependency would be install time on every pipeline of every team: and its hand-rolled verdict reader is
held against `@intentic/sandbox-contract`'s schema by a test instead of by an import.

## Key files

- [src/gate.ts](src/gate.ts), everything the CLI decides, as pure functions: argument parsing, the dialled URL, the verdict reader, the exit mapping.
- [src/cli.ts](src/cli.ts), the process around them: stdin, one fetch, stdout, an exit code.
- [src/gate.test.ts](src/gate.test.ts): the behaviour a pipeline relies on, including the reader-versus-contract agreement test.
