# @intentic/fake-model

A model that answers what a test says, so a provider's real CLI can be driven with no token, no network and no vendor.

## Why it exists

Every provider adapter in this repository was covered by a fake at the seam *below* the CLI: a scripted list of
provider events standing in for `codex app-server`, for OpenCode's SSE stream, for the Claude SDK. That covers
the mapping from provider events onto `AgentEvent`s, and it is worth having.

But both sides of that seam are ours. The provider failures this repository has actually shipped were on the
other side of it — the argv, the config file, the environment, the wire:

- `tools.experimental_request_user_input` changed from a boolean to a table, and the CLI began refusing its own
  config: a turn died before its first token.
- Two undocumented config keys (`model_instructions_file`, `developer_instructions`) carry the whole of the
  Codex runtime's `instructions: "replace"` claim, verified once by hand against one release.
- A turn-specific credential stopped reaching a runtime, and nothing noticed until a user did.

A fake runner cannot see any of these, because the CLI never runs. Worse, the fake and the parser drift
*together*: a vendor changes its behaviour, neither side of our seam moves, and the suite stays green while the
product breaks.

This package moves the fake one layer further out. The real binary starts, reads the real config, assembles its
real prompt, and posts it — here, instead of to the vendor. What comes back is whatever the test scripted, so
the turn is deterministic and costs nothing, and *everything between the daemon and the model is the shipped
article*.

## What a test gets that it cannot get anywhere else

`requests`: the bodies the CLI actually sent.

A capability the catalog claims — that a custom system prompt replaces the runtime's own base prompt, that the
question tool is registered exactly when it was asked for — is a statement about what reaches the model. So it
can only be checked by reading what reached the model. Those claims used to rest on comments recording what
someone once saw on a wire; with this they are assertions, and a CLI bump that breaks one fails a suite instead
of a user's turn.

## The three dialects

Each surface refuses the others' paths rather than answering everything, so a base URL pointed at the wrong one
fails with a sentence naming it instead of passing by accident.

| Route | Dialect | Driven by |
|---|---|---|
| `/v1/responses` | OpenAI Responses (SSE, typed terminal event) | `codex`, and the translator |
| `/v1/chat/completions` | OpenAI Chat Completions (nameless frames, `[DONE]`) | OpenCode's custom providers |
| `/v1/messages` | Anthropic Messages (SSE) | the Claude Code loop, via `ANTHROPIC_BASE_URL` |

## Scripting a turn

Two ways, and the second is usually the right one:

```ts
// By position: step N answers request N, and the LAST step repeats so a retry does not fall off the end.
const model = await startFakeModel({ script: [{ shell: "/bin/echo hi" }, { text: "done" }] });

// By content: each scenario recognizes its own prompt. A retry gets the same answer rather than the next
// test's, and nothing depends on the order the runner picks — which is what lets a suite share one model with a
// runtime whose server cannot be reconfigured per test.
const model = await startFakeModel({ respond: (request) => (asks(request, "MARKER-A") ? { text: "a" } : undefined) });
```

A step is prose (`text`), a shell command (`shell`), a named tool call (`call`), or an HTTP-layer failure
(`failWith`) — which is how a rate limit, an auth refusal or an outage is scripted, because that is where a real
one arrives.

## What the wire actually looks like

Two findings are baked into the readers here because they are invisible from the adapter and expensive to
rediscover:

**The same CLI speaks differently depending on the model.** `gpt-5.2-codex` sends its base prompt as the
top-level `instructions` field and its tools flat; `gpt-5.6-sol` sends the base prompt as the first *developer
message* and its tools inside a namespaced `additional_tools` item. A suite pinned to either passes on half the
catalog and fails on the other half for reasons unrelated to what it is testing. `systemInstructions()` and
`hasTool()` ask what a turn *means* rather than where this month's model puts it.

**The shell is reached two different ways.** `codex app-server` publishes a flat `exec_command` function taking
a `cmd` string; `codex exec` publishes one custom `exec` tool whose input is JavaScript, and the shell is called
from inside it. A step aimed at the wrong one returns a tool-router error rather than a command — which reads as
the runtime refusing to execute. A `shell` step picks the form from the tools the request offered.

## Key files

- [`src/server.ts`](src/server.ts) — the server, the script machine, and the three dialects.
- [`src/responses.ts`](src/responses.ts) — the wire vocabulary and the readers a conformance test asserts
  through; the one file that changes when a vendor moves its shapes.
- [`src/server.test.ts`](src/server.test.ts) — this package is a seam, so it is held to the bar of the code it
  stands in for.

## Who drives it

- [`_sandbox/sandbox/src/codex/codex-wire.e2e.test.ts`](../../_sandbox/sandbox/src/codex/codex-wire.e2e.test.ts)
- [`_sandbox/sandbox/src/grok/opencode-wire.e2e.test.ts`](../../_sandbox/sandbox/src/grok/opencode-wire.e2e.test.ts)

Both are gated by `INTENTIC_E2E_PROVIDERS` and run in CI as `verify-providers`, which gates the release.
