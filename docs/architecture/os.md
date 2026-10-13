# Intentic OS

How intentic runs as the whole operating system of a machine: what the OS image is, who may change it, and how a bad
update or a misbehaving agent is undone without a person at the box.

```mermaid
flowchart TB
    subgraph floor["Deterministic floor: works with no agent"]
        bootc["bootc<br/>A/B deployments"]
        greenboot["greenboot<br/>ic os health each boot"]
        systemd["systemd<br/>restarts, timers"]
        dockerd["dockerd<br/>restart unless-stopped"]
    end
    ic(["ic<br/>the one host authority"])
    agent["intentic-machine<br/>scopes, audit log"]
    steward["Steward sandbox<br/>agent turns"]
    owner["Owner<br/>chat cards, desktop app"]
    steward -->|"device tools"| agent -->|"ic os · ic sandbox"| ic
    owner -->|"yes to a reboot"| steward
    owner -->|"OS card"| ic
    ic --> bootc
    ic --> dockerd
    greenboot -->|"red three boots running"| bootc
```

## What it is

On a PC, a sandbox sits on Windows, WSL's VM and Intentic's engine distro ([`_sandbox/ic/engine`](../../_sandbox/ic/engine)).
Intentic OS removes everything under the engine: the machine boots a bootc image of Fedora
([`_os/os-image`](../../_os/os-image)) whose `/usr` is the image, read-only, with `/etc` and `/var` kept across
updates. Docker is a plain systemd unit, `ic` is in `/usr/bin`, and the machine agent runs as the `intentic` user's
systemd user service, started at boot rather than at a login.

The first boot asks for a setup code (on the screen and on a page on port 80) and runs `ic sandbox connect`, which
starts the first sandbox and connects the machine to it as a device. That sandbox is the **steward**: its agent manages
the machine through the device tools, which are the machine agent's thin callers of `ic`, as every other door is.

## Who may change what

The design rule is that **the agent sits above the deterministic floor and never is it**. The floor keeps a machine
converging when the agent gets something wrong, the agent is down, or the machine has no network:

- dockerd restarts every sandbox after a reboot (`--restart unless-stopped`), and the machine agent's minute tick runs
  `ic sandbox watch`, which puts a failed sandbox update back on its own.
- An OS update is staged by a daily timer and never applied by it. The reboot that applies it is `ic os update
  --apply`, which the steward may run only after the owner's yes in chat (its device skill says so, and the "Manage
  sandboxes" switch gates the verb).
- greenboot runs `ic os health` as a required check on every boot: Docker answers, and every sandbox that ran before
  the reboot runs again with its daemon answering. Three red boots in a row roll the machine back to the previous
  deployment. This is the OS's form of the sandbox update probation ([`update-probation.ts`](../../_shared/sandbox-contract/src/state/update-probation.ts)).
- The steward never receives the Docker socket. What it may do is what the device's scopes allow, enforced on the
  machine ([`policy.ts`](../../_devices/machine/src/device/policy.ts)) and logged there.

The `intentic` user is in the `docker` group, which is root on the machine in all but name, and has sudo for `bootc`
and reboot only. So the boundary that matters is the device scopes, not Unix permissions: an owner who switches
"Run commands" on for the steward has given it the machine.

## Isolation between sandboxes

A sandbox with the Docker capability runs privileged, which under runc is the host's root. On Intentic OS, `ic`
applies the machine's isolation policy (`/etc/intentic/os.json`) to the run command the image hands it: `auto` adds
`--runtime=kata` to a privileged sandbox, so its nested Docker runs inside a microVM with its own kernel. The image's
run contract is untouched: this is a host decision `ic` makes, and only on Intentic OS. A sandbox whose run command asks
for something a microVM cannot honour (the host's network or PID namespace) runs on runc with a warning rather than not
at all.

The image ships `isolation: container` for now. Kata is installed and wired into Docker, but on the only machine it was
tried on (a nested VM under WSL2) its guest dies at boot (`kvm run failed Bad address`), so turning it on by default
would trade a known risk for an unverified one. Flipping the shipped default to `auto` waits for a sandbox seen running
under Kata on bare metal.

## The screen

The desktop edition answers "shared UI layer over sandboxes, or a browser on the OS?" with the existing desktop app as
the shell. Boot, pairing, recovery and switching between sandboxes have to work when no sandbox is up, so they cannot
live inside one. The app already has a local face that needs no sandbox (This device, the engine card, Repair).
Everything else is the editor web app it already loads. sway runs it full screen with Chromium one key away, and the
machine agent drives that screen through sway's IPC like any Linux desktop.

The risk is the renderer: Tauri on Linux is WebKitGTK, which trails Chromium (WebTransport, WebGPU, codecs). The app
reaches the OS only through `ic os … --json`, so moving the shell onto a Chromium kiosk later means a loopback service
in front of those verbs, not a rewrite.

## Channels and releases

`ghcr.io/intentic/os` and `ghcr.io/intentic/os-desktop` carry `beta` (built from main) and `stable` plus `<version>`
(built from a release's own `ic` and desktop app). [`os.yml`](../../.github/workflows/os.yml) boots the server edition
in a VM before it pushes anything, so a tag never points at an image that did not boot. `ic os channel` moves a
machine between them, within intentic's own repositories (the sudo rule allows nothing else).

## How it is checked

[`smoke.sh`](../../_os/os-image/smoke.sh) boots the server edition in a VM and checks Docker, the Kata runtime, the
pairing page, `ic os status` and a green `ic os health` under greenboot; `os.yml` runs it before every push.
[`install-test.sh`](../../_os/os-image/install-test.sh) runs the installer ISO onto a blank disk with Secure Boot and a
software TPM, then checks that the first boot opens the encrypted root by itself; `os.yml` runs it for every release.
What neither can reach: a real pairing (it needs a setup code from an account), a sandbox under Kata (the VMs these run
in are nested), and physical hardware. The [os-image README](../../_os/os-image/README.md) keeps the table of
machines tried.

## Not done yet

- Kata on bare metal: the shipped isolation default moves to `auto` once a privileged sandbox has run under it.
- A device-code pairing (the box shows a short code, the owner types it in the editor) would replace the setup code;
  it needs a platform route and an editor page.
- Machine owner keys for out-of-tree kernel modules (NVIDIA), so GPU boxes keep Secure Boot.
- The hosted plan on bare metal: the same image with `isolation: vm` could replace the per-sandbox Fly machine.
