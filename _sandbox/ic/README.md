# ic

The host-side CLI that starts, updates, diagnoses and removes intentic sandbox containers on the machine that runs them, and gets Docker there first.

```mermaid
flowchart LR
    shim["connect.sh · connect.ps1<br/>setup one-liner"] --> ic(["ic"])
    desktop["Desktop app"] --> ic
    machine["Machine agent<br/>sandbox tools"] --> ic
    hosted["Platform<br/>hosted overlay builds"] --> ic
    ic --> docker["Docker<br/>sandbox containers"]
    ic --> image["Sandbox image<br/>run contract"]
    ic --> claim["Platform<br/>setup-code claim"]
```

- Runs on the host: a laptop, a server or a hosted machine, never inside a sandbox, which cannot see its siblings.
  The bootstrap shims download a fresh static binary on every run; the desktop app and the machine agent call the
  installed one. An agent reaches it through a connected device's sandbox tools.
- `ic sandbox connect <code>` redeems the setup code from the platform and brings a sandbox up. `update`, `prepare`,
  `rollback`, `rebuild` and `reshape` swap or restart the container while keeping `/work` and `/history`; `remove`
  moves the data to a trash that `restore` brings back and `purge` empties early.
- **ic is the one host authority for what runs and what should run.** Every door onto a sandbox's container (the
  machine agent, the desktop app, the web's pasted fallback lines) calls ic's verbs rather than docker: `start`,
  `stop` and `restart` power the tunnel sidecar with its sandbox, and `ic sandbox list --json` answers each
  sandbox's state, its share as docker enforces it, the shape it runs with, the shape saved for its next restart and
  the update staged for it, in the sandbox contract's `DeviceSandbox` shape.
- Before a swap touches the running container, it pre-flights the target image's state conversions against
  read-only mounts of the container's data (`/work`, `/history`, and `/agent-auth` where the container has it: the run
  contract's `DATA_MOUNTS`, held to it by a golden test) (`preflight.rs`) and refuses if one would fail;
  `--skip-preflight` overrides. `prepare` records the staged image's plan in the marker it leaves the sandbox, the
  planner's line verbatim, so the update card says what an update converts before anyone accepts it. A new version that never commits its state journal is rolled back
  onto the parked container.
- A sandbox's **shape** is the owner's own ask for memory, CPUs, privileged and GPU, always whole
  ([`shape.rs`](src/shape.rs)). `ic sandbox shape <slug> … --when now` restarts onto it; `--when next-restart` checks
  it against the image's run contract (a bad value is refused here, not by the next update) and saves it as the
  channel record's `desired_*` keys, next to what `prepare` staged. The next restart through ic applies it and drops
  it in the same record write that names the new image: `start`, `restart`, an update, a rollback, a rebuild or a
  `reshape`. Docker restarting the container by itself (`--restart unless-stopped`) does not. `--forget` drops it.
  `reshape --later`/`--forget` are the older spellings, kept one release for machine agents that send them; a
  `sandbox-<slug>.shape` delta an older ic saved is converted into the record the first time it is read, then deleted.
- `ic sandbox doctor` walks the reachability chain (machine, container, daemon, platform, edge) and names the broken
  link with its fix.
- The image owns its `docker run` flags. `ic` asks the image for its run command (`contract.rs`) instead of
  writing one, so a flag change ships with the image.
- `ic docker prepare` checks and, with consent, installs what Docker needs; `ic machine enroll` makes the host a deploy
  target; `ic runner up` starts a runner container for a parent sandbox.

## Key files

- [src/main.rs](src/main.rs) — every command and flag, with its help text.
- [src/sandbox/connect.rs](src/sandbox/connect.rs) — the setup one-liner's flow after Docker: claim, launch, reachability.
- [src/sandbox/recreate.rs](src/sandbox/recreate.rs) — every image swap (update, prepare, rollback, rebuild, reshape) as one flow.
- [src/contract.rs](src/contract.rs) — asks the image for its `docker run` command.
- [src/sandbox/desired.rs](src/sandbox/desired.rs) — the shape saved for the next restart: set, check, forget, and the old file's conversion.
- [src/prepare/mod.rs](src/prepare/mod.rs) — `ic docker prepare`: facts, plan, fixes.

## Commands

```sh
cargo test --manifest-path _sandbox/ic/Cargo.toml --workspace   # ic, and the bounded-capture crate the desktop app shares
bash _tools/scripts/build/build-ic.sh linux-x64   # release binaries into _sandbox/ic/dist-bin/
```
