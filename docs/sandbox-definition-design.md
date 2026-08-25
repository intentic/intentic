# The sandbox definition: the design

How a sandbox's environment splits into a declarable SHAPE (`sandbox.toml`) and irreplaceable STATE (the
bundle), why the shape earned its own format, and what the split buys: fleets stamped from one file,
environments that get code review, drift as a computation, and an export that is safe to publish. This records
the reasoning; the implementation lives in `_sandbox/sandbox/src/portability/` (definition.ts,
apply-definition.ts, the `/definition/*` routes) with the schemas in `_sandbox/sandbox-contract/src/definition.ts`
and the card on Sandbox → Environment.

## 1. The observation

The bundle was never a naive filesystem capture. Every piece of daemon state already declares one of four
portability classes (`carry` / `secret` / `identity` / `derived`, `state-portability.ts`), and three of the
four are already "pulled from a source of truth on the other side": secrets re-entered, identity re-minted,
derived state regenerated. The tar exists only for `carry`.

The observation this design acts on: **`carry` itself splits the same way.** Some of it is genuinely state
(transcripts, checkpoint timelines, unpushed branches, ledgers) that nothing can reproduce. The rest is a
REFERENCE wearing a byte costume: a repo *is* its remote plus a ref; a capability manifest already holds the
shape of a connection and never its credential (the vault split argued on `workspace-state.ts`'s
capabilities.json entry); the overlay's source section is small text; agent settings are a dozen decisions.
That half deserves a face humans can write, diff and hand to each other.

## 2. What a definition is, and refuses to be

A definition carries, by reference: repositories (remote + ref), capabilities (id, kind, config — post-sweep,
so never a credential value), secret NAMES, the overlay Dockerfile as source, and the agent settings that
differ from their defaults. It deliberately cannot carry:

- **Consent.** The approval hash never travels. An applied definition writes its Dockerfile as an
  agent-style draft (`environment.d/definition.Dockerfile`), so it composes into a proposal at the owner's
  approval gate. A bundle restore writes the approved custom section directly, and the asymmetry is the trust
  model: a bundle is the owner's own sandbox coming back, a definition is a file anyone may have handed them.
- **Credentials or identity.** Capabilities land listed and unauthenticated; secrets land as names to fill.
  This is what makes a definition publishable where a bundle never is.
- **Content.** Drafts, authored skills, workspace extensions, personas, automations: bundle territory, each
  with its reason stated in `DEFINITION_EXCLUDED` rather than silently absent.

One schema serves both doors: the bundle manifest (v2) embeds the definition, so a bundle is definition +
state and the restore report reasons over the same facts either export emits.

## 3. Why TOML

The artifact is manifest-shaped: shallow sections, arrays of records, one multi-line Dockerfile block,
hand-edited, reviewed, diffed. That profile has a settled answer (Cargo.toml, pyproject.toml). Against the
alternatives: YAML brings coercion traps (`no` is a boolean, `1.0` is a float) into a file people hand-edit;
JSON-family has no multi-line strings, so a Dockerfile becomes escaped noise; KDL asks every consumer to learn
a niche format for one file; CUE/Pkl/Dhall are programmable, and a file strangers hand around must not execute
logic. The emitter is hand-rolled (~80 lines) because its two requirements are exactly what no library
promises together: byte-identical output for equal input, and comments. Parsing is smol-toml (strict TOML 1.0)
followed by the contract schema, so a hand-edited file fails naming the field rather than half-applying.

## 4. The rules it inherits

Nothing here invented a posture; each rule is lifted from a neighbour that already argued it:

- **Derived, never stored** (the environment card's rule): there is no definition file the daemon keeps in
  sync. Every export walks the live manifests, so it cannot be stale, and drift becomes `definitionDiff`, a
  pure comparison.
- **Preview-first, re-derived at apply** (the migration surface's rule): `plan` holds the parsed document in
  memory under a token and renders a checklist; `apply` re-derives the items from the held bytes and honors
  ticked ids against that, never against the wire plan the browser rendered.
- **Native write paths only** (the migration surface again): a repo arrives through the daemon's own clone
  (separate git dir on `/history`), a capability through the manifest store, settings through the settings
  store — so everything an applied definition creates is editable and deletable in the ordinary UI the day
  after.
- **Beside, never over**: an existing repo directory or capability id renders its item inapplicable with the
  reason. "Make this sandbox match the file" is the diff surface's job, not the apply's.
- **Honesty as a list** (the import report's rule): what the derivation could not express (a repo with no
  remote) and what no apply can do (approve the overlay, enter credentials) are lines with subjects, at
  preview time and again on the report.

## 5. The seed door

`sandbox-run` gained a `definition` option: the TOML rides into the container as `SANDBOX_DEFINITION_SEED`
(base64, so its quotes never meet a shell), and a boot step applies everything applicable — only while the
workspace is still as it arrived, so a rebuild replaying the env is inert. One definition, N sandboxes: the
fleet use case, with the owner's arrival checklist in the boot log's report.

## 6. The guard that keeps it honest

`definition-coverage.test.ts` holds two lists in `portability/definition.ts` against the state table: every
`versioned` config manifest must be a definition SOURCE or EXCLUDED with a note. A config surface added next
quarter is a red test until someone answers "declarable, or content only a bundle can move?" — the same
discipline the portability classes enforce one level down, applied one level up.
