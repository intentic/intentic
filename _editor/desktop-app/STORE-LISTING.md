# The Microsoft Store listing, field by field

Everything Partner Center asks for, written out so submitting is copying rather than composing. The dashboard
is the only place most of these can be entered; the automation
([`publish-msstore.mjs`](../../_tools/scripts/release/publish-msstore.mjs)) writes exactly two of them —
**Packages** and **What's new** — and never touches the rest.

Keep this file and the listing in step: a claim that lives only in the dashboard is one nobody reviews.

[docs/ops/microsoft-store.md](../../docs/ops/microsoft-store.md) is how the account, the app and the API
credentials are set up. This file is what goes in the form once they exist.

---

## Product name (reserved first, before anything else)

```
Intentic
```

Reserving the name creates the product and gives you the **product id** the automation needs.

## Pricing and availability

- **Price**: Free
- **Markets**: all
- **Discoverability**: Make this product available and discoverable in the Store
- **Free trial**: none (it is free)

## Properties

- **Category**: Developer tools → **Utilities**
- **Privacy policy URL**: <https://intentic.dev/privacy>
- **Website**: <https://intentic.dev>
- **Support contact**: <https://github.com/intentic/intentic/issues>
- **Additional license terms**: `MIT — https://github.com/intentic/intentic/blob/main/LICENSE`
- **Product declarations**: no drivers or NT services, no pen and ink support; accessibility support is not
  claimed (the app has not been tested against the accessibility requirements, and claiming it untested is
  the thing certification actually objects to)
- **System requirements**:
  - Minimum memory **8 GB** — a sandbox is a container and the image is not small
  - Minimum: Windows 10 21H2 or later, 64-bit, with virtualization available for WSL2
  - Recommended memory **16 GB**

## Age rating

Complete the questionnaire: no user-generated content shown to others, no advertising, no data collection that
identifies a person to other users. It rates as **general audiences** on every board.

## Store listing (English, United Kingdom)

### Short description (1,000 characters max)

```
Run an AI coding agent on your own computer, in a sandbox: one container per project, with your repository,
your tools and an agent that works in it. No terminal needed.
```

### Description (10,000 characters max)

```
Intentic gives you a sandbox — a private box on this computer holding your repository, your tools and an AI
agent that works in it. Every agent gets its own git worktree, so two of them can work at once without
touching each other's files, and you land the result when you are happy with it.

This app is the no-terminal way to run one. Install it, sign in, and press "Run on this computer": it checks
whether Docker is there, sets it up if it is not, pulls the image, starts your sandbox and opens your
workspace. After that it is the thing that keeps the sandbox running and updated — start, stop, logs, disk,
memory and CPU limits, roll back to the previous image — from a window instead of a command line.

WHAT YOU GET
• A sandbox per project, on your own machine. Your code stays on your disk; the container mounts it
• An agent that can actually run things: install packages, run tests, start servers, drive a browser
• Parallel agents, each in its own git worktree, each with its own terminal and preview
• The same workspace in your browser, on any device, over an outbound tunnel — the app and the browser are
  two faces of one sandbox, not two products
• Docker set up for you on Windows, including WSL2, with every prompt explained before it appears

WHAT IT DOES TO YOUR COMPUTER
• Installs Docker Desktop if you do not have it, and turns on WSL2. Both need administrator, Windows asks you
  for it, and the app says what it is about to do before the prompt appears
• Downloads the sandbox image (several GB) and runs two containers per sandbox
• Registers intentic:// links so the workspace can open sandboxes and setup codes
• Updates itself, and tells you when a sandbox's image has a newer version

You need an Intentic account to sign in: https://intentic.dev
```

### Product features (up to 20, 200 characters each)

```
One sandbox per project, on your own computer — your code stays on your disk
Sets up Docker and WSL2 for you, explaining every prompt before it appears
Parallel agents, each in its own git worktree
Start, stop, update, roll back and read the logs of every sandbox from one window
The same sandbox in your browser from any device
Open source, MIT licensed
```

### Search terms (up to 7, 30 characters each, 21 unique words in total)

```
ai agent
coding agent
docker sandbox
developer workspace
git worktree
devcontainer
```

### What's new

**Written by the automation on every release.** It carries the release's `## What's new` and
`## Breaking changes` bullets and a link to the full notes, and there is no reason to type one by hand —
anything entered here is replaced by the next release.

### Screenshots

At least one 1366×768 or larger. Take them from the real app rather than the marketing site:

- the **This computer** screen with a sandbox running, which is what the app is for
- the **setup** screen mid-install, which is the part no other tool does for you
- the workspace window, so the listing shows what the sandbox is for

### Copyright and developer

- **Copyright**: `© Intentic`
- **Developed by**: `Intentic`

## Certification notes

These go in **Submission options → Notes for certification**, and they are worth writing carefully: everything
below is something a tester meets in the first two minutes and would otherwise file as a defect.

```
Intentic runs AI coding agents in Docker containers on the user's own machine. This app is the installer and
lifecycle manager for those containers.

SIGN-IN. The app opens https://app.intentic.dev and needs an account. Test credentials are in the field
below / attached; the whole app is reachable with them.

WHAT THE INSTALLER DOES. It installs a per-user application (no administrator needed) and registers the
intentic:// URL scheme. The silent switch is /S.

WHAT THE APP DOES ON FIRST RUN, with the user's confirmation and never silently:
• Checks for Docker Desktop. If it is absent, it installs it — through winget where available, otherwise by
  downloading Docker Inc.'s own signed installer from docker.com.
• Turns on WSL2 and the two Windows features it needs. This requires administrator, Windows shows its own
  consent prompt, and a restart may follow.
• Pulls the Intentic sandbox image (several GB) and starts two containers.
Each of these is announced on screen before it happens and can be declined; the app is usable as a viewer
without them.

NETWORK. The app talks to app.intentic.dev (the hosted workspace), ghcr.io (the sandbox image), github.com
(its own updates), and docker.com only if Docker has to be installed.

UPDATES. This installer is not Store-managed: the app updates itself from its GitHub releases, which is how
copies installed from our own download page behave too.

Source, including this installer's build: https://github.com/intentic/intentic
```

Create a dedicated Store-review account rather than handing over anyone's real one, and note in the dashboard
that it exists so the next submission does not mint a second.

## Packages — do not edit by hand

The automation replaces this module on every release with a single package:

| Field | Value |
| --- | --- |
| Package URL | `https://github.com/intentic/intentic/releases/download/v<version>/Intentic-<version>-x64-setup.exe` |
| Architecture | x64 |
| Languages | en-us |
| Installer type | EXE |
| Silent install | requires a switch: `/S` |
| Error code documentation | <https://intentic.dev/docs/troubleshooting/#installer-exit-codes> |
| Custom error codes | `1` cancelled, `2` install failed (NSIS's own) |

Editing a package by hand is safe but pointless: the next release overwrites the module. Editing the URL to
anything that is not a versioned release asset is not safe — Microsoft re-certifies a listing whose binary
changes underneath it, and the site's `/desktop/windows` path always resolves to the newest release.
