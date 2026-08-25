# Provider conformance: never release with a broken provider

## The problem this solves

The daemon runs seven runtimes behind one seam. Coverage of that seam was deep — 400+ test files in
`_sandbox/sandbox` alone — and yet Codex and Cursor both broke in ways no test could see.

The reason is where the fakes sit. Every provider adapter was tested against a scripted stand-in for the CLI
(`fakeCodexRunner`, a fake `QueryFn`, canned OpenCode events). Both sides of that seam are ours, so:

- **A vendor changing its behaviour moves neither side.** The fake and the parser drift together, and the suite
  stays green while the product breaks.
- **The half where the failures happened was never exercised at all** — the argv, the config file, the
  environment, the wire.

Three drift classes, needing three different defenses:

| Class | Example from this repo | Defense |
|---|---|---|
| **Our-side regression** — a shared change breaks one runtime | the recent `fix: codex`, `fix: codex, cursor` commits | real-CLI conformance, gating the release |
| **Vendor-side drift** — a pin bump changes behaviour | `experimental_request_user_input` bool → table, which killed a turn before its first token | a canary running the same assertions against `@latest` |
| **Capability-claim drift** — the catalog says a runtime does X; it quietly stops | `instructions: "replace"` resting on two undocumented keys | assertions read off the outbound model request |

## The design

One idea: **replace the model, not the CLI.**

The real binary starts, reads the real `config.toml` and `hooks.json`, assembles its real prompt, and posts it —
to a local scripted server ([`@intentic/fake-model`](../_tools/fake-model/README.md)) instead of to the vendor.
The turn is deterministic and costs nothing, and everything between the daemon and the model is the shipped
article.

That buys the thing nothing else can: **the bodies the CLI actually sent**. A capability the catalog claims is a
statement about what reaches the model, so it can only be checked by reading what reached the model. Those
claims used to rest on comments recording what someone once saw on a wire ("verified against codex-cli 0.147").
Now each is an assertion.

### Three tiers

| Tier | What runs | When | Gates? |
|---|---|---|---|
| **Unit / integration** | scripted seams, as before | every PR | yes (`verify-core`) |
| **Conformance** | real CLI + scripted model, no network | every PR + release | **yes** (`verify-providers`) |
| **Canary** | the same assertions against `@latest` CLIs | nightly | no — alerts |

The conformance tier gates the release *because it is hermetic*: no token to expire, no quota to exhaust, no
vendor outage to be reddened by. Those are exactly the failure modes that make a real-model test unfit to block
a release. It runs in ~10 seconds.

It also **does not stand down quietly**. `e2eTier` lets a suite with no credentials skip rather than fail, which
is right for a tier needing somebody's Cloudflare token. This tier needs only the CLI the image bakes, so "asked
for, and the binary is missing" fails and names the pack. A release gate that skips itself is not a gate.

### What is asserted

Per provider, per model family, through readers that ask what a turn *means* rather than where a particular
release puts it:

a plain turn completes once · the turn's own bearer and nothing else authenticates · a shell command is really
executed and its output returns · a custom system prompt replaces (or appends, per the runtime's declared
capability) · the question tool is registered exactly when asked for and withheld from an unattended turn · the
selected model reaches the wire · a resumed turn carries its history · a refusal becomes an error frame and the
turn still ends · `cliEnv` reaches the spawned process · `CODEX_HOME` is the turn's own · the advisory
classifier still recognizes what the CLI actually says.

### Version integrity

Two halves, because they are different failures:

- `packs.integration.test.ts` compares the pack pin to the daemon's dependency — catches a bump on one side only.
- The same file now also compares the **installed** CLI's `--version` to the pin — catches an image built before
  the last bump, or a stale global install shadowing it. Absent is not a failure; *wrong* is. Without this the
  conformance tier can pass against a version nobody ships.

`_tools/scripts/install-provider-clis.sh` reads the pins from the pack Dockerfiles rather than keeping a copy, so
there is no third place for the number to be wrong. `--latest` is the canary's mode.

## What the wire actually says

Findings from building this, each now pinned by a test:

1. **The wire surface depends on the model, not the entry point.** `gpt-5.2-codex` sends its base prompt as the
   top-level `instructions` field with flat tools; `gpt-5.6-sol` sends it as the first developer message with
   namespaced tools and reaches the shell through a JavaScript isolate. Every scenario runs against both.
2. **`instructions: "replace"` is true** — `model_instructions_file` really does replace the base prompt, and
   `developer_instructions` really does append without disturbing it. Both now proven per release rather than
   per memory.
3. **The bare-boolean `experimental_request_user_input` is a config-load failure**, confirmed: the CLI never
   reaches the model at all. The tier fails on the request count before it fails on anything confusing.
4. **`codex` 0.147 does not know `gpt-5-codex`** — the id several comments still name. An unknown id produces a
   `codex-advisory` frame, which is non-fatal by design; that classification is a regex over vendor prose, so it
   is now pinned against the live CLI.
5. **A 429 costs a Grok/Gemini user ~71 seconds** before any error surfaces: OpenCode retries internally well
   past the point the turn looks hung.

## Known gaps

Deliberately not closed yet, in priority order:

- **Claude Code and Cursor have no conformance tier.** The shim already speaks Anthropic Messages, and the
  Claude loop honours `ANTHROPIC_BASE_URL`, so that tier is mostly scaffolding. Cursor's SDK talks to its cloud
  with no endpoint override and no translator route, so its tier can only cover everything up to the network
  (SDK resolution from the pack prefix, the hooks socket, key handling, version skew) — worth having, since that
  is where its shipped bugs were.
- **No Level 3 nightly smoke.** One real turn per credentialed provider through the built image would catch
  credential and vendor-availability breakage that the hermetic tier cannot see by construction. It belongs in
  `nightly.yml` beside the canary, alerting rather than gating.
- **No cross-suite load budget.** Building this surfaced a sharp lesson: the OpenCode tier originally leaked an
  `opencode serve` (~350 MB) on every run, because the service had no way to stop the server it booted. Repeated
  runs drove the machine's load average past 16, and timing-sensitive integration tests *elsewhere in the
  repository* began failing — a different subset each time. That reads as a flaky suite and is actually a leak.
  `OpenCodeService.stop()` fixes this instance; nothing yet stops the next suite from doing the same.
- **No recorded golden fixtures.** The conformance tier subsumes most of their value (it reads the live wire
  rather than a memory of it), but recorded request bodies would make "what changed in this vendor release" a
  reviewable diff.
