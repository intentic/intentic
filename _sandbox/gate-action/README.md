# @intentic/gate-action

The GitHub Action around the sandbox's two CI doors: one `uses:` step that waits on a release gate's verdict or wakes an event automation with the workflow's payload.

## Responsibilities

The daemon already serves two routes a CI system can call: the release gate, which holds the connection while
a workflow runs and answers a verdict, and the event automation's webhook, which wakes the agent and answers
immediately. `@intentic/gate` is the caller's side of the gate exchange as an npx one-liner; this package is
the same exchange as a Marketplace action: the form a GitHub workflow actually installs things in:

```yaml
- uses: intentic/gate-action@v1
  with:
    url: ${{ secrets.INTENTIC_URL }}
```

The URL the user pasted already names its door, so the action reads the path instead of asking for a mode
input that could disagree with it: `…/workflows/<id>/gate` blocks and maps the verdict onto the step:
`pass` green, `fail` red, `blocked` green unless `blocked-as: failure` says otherwise, because "the check
could not judge" must never read as "the product is broken": and `…/automations/<id>/fire` posts the
workflow's event payload (the same JSON a GitHub webhook would have delivered) and moves on. The verdict
comes back as step outputs (`outcome`, `reason`, `run-id`, `value`) and a step summary, so a team can chain
its own PR comment without this action learning how to write one.

The runner protocol: `INPUT_*` variables in, `GITHUB_OUTPUT`/`GITHUB_STEP_SUMMARY` appends and `::error::`
lines out, is spoken by hand: `@actions/core` would be the only dependency in a closure that is otherwise
@intentic/gate's zero, bundled into the dist every workflow downloads.

## The Marketplace artifact

A Marketplace listing requires a public repository with `action.yml` at its root, so this package is not
npm-published (`private: true`), its build bundles `src/main.ts` and everything it imports into a single
`dist/index.mjs`, and the release pipeline syncs `action.yml`, the bundle and `marketplace/README.md` to the
root of the public `intentic/gate-action` repository, tagging it with the release version and moving the
floating `v1`. The runner executes the bundle directly; nothing in it may assume `node_modules` exists.

## How it fits

The gate route (`_sandbox/sandbox`, gate.routes.ts) and the fire route (app.ts) are the daemon's doors for a
caller with no identity; the workflows extension's gate panel is where a gate is declared and its URL copied,
and the GitHub step it offers to copy is this action's `uses:` line (gateSnippets.ts). `@intentic/gate` stays
the answer for every other CI system (GitLab's snippet still runs it with npx) and owns the pure exchange
logic this package imports rather than re-implements.

## Key files

- [action.yml](action.yml), the Marketplace metadata: inputs, outputs, branding, the node entry; synced verbatim to the public repo's root.
- [src/action.ts](src/action.ts), everything the step decides, as pure functions: input parsing, door detection, the default request, output serialization, the verdict-to-step mapping.
- [src/main.ts](src/main.ts), the process around them: environment in, appended runner files and an exit code out.
- [src/action.test.ts](src/action.test.ts): the behaviour a workflow relies on, held against the contract's verdict schema.
- [marketplace/README.md](marketplace/README.md), the public repository's README: what a team installing the action reads.
