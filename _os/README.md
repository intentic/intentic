# Intentic OS

An immutable Linux that boots straight into Intentic: Docker, `ic`, the machine agent and a first sandbox that manages the box, with nothing else to install or keep up to date by hand.

```mermaid
flowchart TB
    subgraph os["Intentic OS image (bootc: A/B deployments, rollback)"]
        systemd["systemd · greenboot<br/>health checks"]
        dockerd["dockerd<br/>runc · kata"]
        ic(["ic<br/>the host authority"])
        agent["intentic-machine<br/>user service, scopes + audit"]
        pair["intentic-pair<br/>first boot: setup code"]
        shell["desktop edition:<br/>sway kiosk + Intentic app"]
    end
    pair -->|"ic sandbox connect"| ic
    steward["Steward sandbox<br/>(the first one)"] -->|"device tools"| agent
    agent -->|"ic os · ic sandbox"| ic
    ic --> dockerd
    dockerd --> sandboxes["Sandboxes<br/>runc, or a microVM"]
    ic -->|"sudo bootc"| systemd
    shell -->|"loopback"| steward
```

On a Windows PC a sandbox sits on Windows, WSL's VM and Intentic's engine distro. On Intentic OS the same parts
run on the metal: dockerd is a plain systemd unit, `ic` is in `/usr/bin`, and the machine agent runs as a user
service of the `intentic` user, started at boot (linger), not at a login. The agent in the first sandbox manages the
box through the machine agent's device tools, which are thin callers of `ic`. It never gets the Docker socket. The
deterministic layer (systemd restarts, `ic sandbox watch`, greenboot's rollback) keeps the box converging when the
agent gets something wrong.

| Package | Role |
| --- | --- |
| [os-image](os-image) | The bootc images (`ghcr.io/intentic/os`, `ghcr.io/intentic/os-desktop`), their files, build and boot test |

## Editions and channels

- **server** (`ghcr.io/intentic/os`): headless. Reached from app.intentic.dev and the phone apps, paired from a
  page on the local network or the console.
- **desktop** (`ghcr.io/intentic/os-desktop`): the server image plus a sway kiosk session that opens the Intentic
  desktop app full screen, and Chromium for the owner's own browsing.
- A channel is the image tag: `stable` or `beta`. `ic os channel beta` switches, keeping the edition.

## The host interface

Everything that changes the OS goes through `ic os`, and everything that calls it (the machine agent's tools, the
desktop app, greenboot, the systemd units) reads its JSON rather than bootc's. `ic os` refuses with exit code 3 on a
machine that is not Intentic OS (no `/usr/lib/intentic-os/release.json`).

| Verb | What it does | Needs root |
| --- | --- | --- |
| `ic os status --json` | One line of JSON, the shape below | no (bootc status through `sudo -n`) |
| `ic os update --check --json` | Asks the registry whether a newer image is out: `{"available", "version", "digest"}` | sudo |
| `ic os update` | Downloads and stages the newer image for the next boot; nothing restarts | sudo |
| `ic os update --apply` | Stages it, then reboots into it (see Reboots); no reboot when nothing new was staged | sudo |
| `ic os update --scheduled` | What the daily timer runs: `ic os update`, or nothing when the policy says `updates: off` | root |
| `ic os rollback [--apply]` | Queues the previous deployment for the next boot; `--apply` reboots into it | sudo |
| `ic os channel <stable\|beta>` | Stages the same edition from another channel (`bootc switch`) | sudo |
| `ic os reboot` | Reboots, the orderly way (see Reboots) | sudo |
| `ic os record` | Writes which sandboxes run now to `/var/lib/intentic-os/expected-running.json` | docker |
| `ic os health [--wait <s>]` | The boot's health verdict; exit 0 when healthy (greenboot calls it) | docker |
| `ic os pair` | First boot: waits for a setup code on the console and on a LAN page, then `ic sandbox connect` | docker |

### `ic os status --json`

```json
{
    "os": "intentic-os",
    "edition": "server",
    "version": "2026.10.13.0",
    "channel": "stable",
    "image": "ghcr.io/intentic/os:stable",
    "booted": { "image": "ghcr.io/intentic/os:stable", "version": "2026.10.13.0", "digest": "sha256:…", "timestamp": "2026-10-13T09:12:00Z" },
    "staged": null,
    "rollback": { "image": "ghcr.io/intentic/os:stable", "version": "2026.10.06.0", "digest": "sha256:…", "timestamp": null },
    "rollbackQueued": false,
    "rebootRequired": false,
    "health": { "verdict": "green", "failed": [] },
    "isolation": "container",
    "vmRuntime": true
}
```

- `edition`, `version` and the default `channel` come from `/usr/lib/intentic-os/release.json`, which the image
  build writes. `channel` is read from the booted image's tag when it has one. `image` is the image the machine
  follows (bootc's `spec.image`), so right after `ic os channel beta` it names `:beta` while `channel` still says
  what is booted.
- `booted`, `staged` and `rollback` come from `bootc status --json` (`status.booted|staged|rollback`), each
  `{image, version, digest, timestamp}` with `null` for what bootc does not say. `staged` and `rollback` are `null`
  when there is none.
- `rebootRequired` is `staged != null || rollbackQueued`.
- `health` is the last verdict `ic os health` wrote for this boot (`/run/intentic-os/health.json`), `unknown` before
  it ran. `failed` says each failed check in words (`sandbox <slug> is not running`).
- `isolation` is the host policy below, `vmRuntime` whether dockerd has the `kata` runtime.

### Reboots

`ic os update --apply`, `ic os rollback --apply` and `ic os reboot` first leave every running sandbox the daemon's
resume ask (`/history/restart-resume.json`, as every other restart `ic` makes does), then `ic os record`, then
`systemctl reboot`. The `intentic-os-record` unit also runs `ic os record` at every orderly shutdown, so a reboot
from anywhere else is covered too.

### Health and rollback

greenboot runs `ic os health --wait 600` as a required check on every boot: dockerd answers, and every sandbox in
`expected-running.json` is running again with its daemon answering within the wait. A failed required check
makes greenboot reboot, and after three failed boots it rolls back to the previous deployment. The verdict is also
written to `/run/intentic-os/health.json` for `ic os status`.

### Pairing

`ic os pair` runs only while this machine has no sandbox (`intentic-pair.service`, as the `intentic` user). It
prints, on the console, where to get a setup code (app.intentic.dev, New sandbox, On my own machine) and the local
page's address, `http://intentic.local` or the IP. It takes a code typed on the console, or pasted on that page (the
whole setup command is accepted; the code is read out of it), and runs `ic sandbox connect <code> -y`, which starts
the sandbox and connects this machine as its device, so the new sandbox can manage it. The page is served only until
pairing succeeds, and `pairOnLan: false` turns it off. It answers only to this machine's own names and addresses and
refuses a form posted from another site, so a page elsewhere cannot pair the box to someone else's account; anyone on
the same network who reaches it first still can, which is why the console is the place to pair a box on a shared
network. When port 80 cannot be opened the page moves to 8080 and says so.

### Host policy: `/etc/intentic/os.json`

Defaults ship in `/usr/lib/intentic-os/os.json`; the owner's own values in `/etc/intentic/os.json` win, key by key.

```json
{ "isolation": "container", "pairOnLan": true, "updates": "stage" }
```

- `isolation`: how sandbox containers run. `container` is runc. `vm` runs every sandbox container in a Kata microVM
  (`--runtime=kata`). `auto` uses a microVM for sandboxes started privileged (the Docker capability), where runc would
  hand the sandbox the host's root, and runc for the rest. Without the `kata` runtime, or for a run command a microVM
  cannot honour (the host's network, PID or IPC namespace, the Docker socket, GPUs), `ic` warns and uses runc. Only
  sandbox and runner containers change; the tunnel sidecar stays on runc. The image ships `container` until a sandbox
  has been seen running under Kata on real hardware (2026-10-13: the only test machine was a nested VM, where Kata's
  guest does not boot); an owner opts in with `{"isolation": "auto"}` in `/etc/intentic/os.json`. A value `ic` does
  not understand reads as `auto`, the stricter choice.
- `updates`: `stage` downloads a new OS image daily and waits for an approval to reboot into it (`ic os update
  --apply`, from the agent's card or the desktop app); `off` checks nothing.

### Files

| Path | What |
| --- | --- |
| `/usr/lib/intentic-os/release.json` | `{ "name": "Intentic OS", "edition", "version", "channel", "repository" }`, written at build |
| `/usr/lib/intentic-os/os.json` | The policy defaults |
| `/etc/intentic/os.json` | The owner's policy |
| `/var/lib/intentic-os/expected-running.json` | `{ "recordedAt": <ms>, "slugs": [...] }` |
| `/run/intentic-os/health.json` | `{ "verdict": "green"\|"red", "failed": [...], "at": <ms> }` |
| `/etc/sudoers.d/intentic-os` | The `intentic` user may run `bootc` and `systemctl reboot` without a password |
