<div align="center">

<a href="https://intentic.dev"><img src="docs/marketing/intentic-lotus.svg" alt="intentic lotus" width="72" height="72"></a>

# intentic

An open-source workspace for coding agents, running on your own machine.

<p>
  <a href="https://github.com/intentic/intentic/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/intentic/intentic/ci.yml?branch=main&amp;label=CI&amp;labelColor=24211e&amp;color=e07b27"></a>
  <a href="https://github.com/intentic/intentic/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/intentic/intentic?sort=semver&amp;label=release&amp;labelColor=24211e&amp;color=e07b27"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-e07b27?labelColor=24211e"></a>
</p>

**[Live demo](https://intentic.dev/demo/)** · **[Create a workspace](https://app.intentic.dev)** · **[Download](https://intentic.dev/download)** · [Docs](https://intentic.dev/docs) · [Discord](https://discord.gg/3veuzYp32T)

<a href="https://intentic.dev/demo/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="_site/site/src/assets/product/fleet-board.png">
    <img src="_site/site/src/assets/product-light/fleet-board.png" alt="The agent board: runs grouped into Attention, Active and Finished." width="100%">
  </picture>
</a>

</div>

## What it does

- **Parallel agents.** Every task runs in its own git worktree and branch, so agents never step on each other.
- **Review before it lands.** Chat, files, terminals and diffs sit in one workspace. Work stays on its branch until you land it.
- **Keeps running.** The sandbox lives on a machine you control. Close the browser and reopen from any device, phone included.
- **Your subscriptions.** Bring Claude Code, Codex, Cursor, Gemini, Grok, Kimi or any ACP agent. intentic is free and MIT-licensed.
- **Extensible.** Connectors, MCP servers, automations and extensions give agents the tools a task needs.

## How it fits together

```mermaid
flowchart LR
    you["You<br/>browser · desktop · phone"] --> editor["Editor<br/>_editor"]
    editor --> platform["Platform<br/>sign-in · tunnel"]
    platform --> sandbox(["Sandbox daemon<br/>_sandbox"])
    sandbox --> agents["Agents<br/>one worktree each"]
    agents --> repos["Your repositories"]
    sandbox --> ext["Extensions<br/>_extensions"]
    sandbox --> devices["Your devices<br/>_devices"]
    agents --> search["Code search<br/>_search"]
```

## Get started

1. **[Sign in](https://app.intentic.dev)** and create a workspace, or try the **[demo](https://intentic.dev/demo/)** first.
2. **Connect a machine.** Run the setup command the app shows on the laptop, desktop or server that will host your sandbox. The tunnel is outbound, so no ports need opening.
3. **Connect an AI account** and give an agent a task.

The [quickstart](https://intentic.dev/docs/quickstart/) covers servers and the desktop app.

## Repository

| Area | What lives there |
| --- | --- |
| [_editor](_editor) | The web app you look at, plus desktop and mobile shells and the UI kit |
| [_sandbox](_sandbox) | The daemon that owns a project's box, and the CLIs agents use inside it |
| [_platform](_platform) | The hosted plane: sign-in, sandbox registry, tunnels, database |
| [_extensions](_extensions) | Bundled extensions: agents, connectors, automations, viewers |
| [_shared](_shared) | Contracts and SDKs more than one part is written against |
| [_search](_search) | `iq` and `lsp`: how agents find code |
| [_devices](_devices) | What runs on your own machines: device agent, browser extension |
| [_deploy](_deploy) | The deployment tool: intent to running servers |
| [_site](_site) | intentic.dev and the interactive demo |
| [_tools](_tools) | Shared config, checks, test harnesses, maintainer scripts |

Start with [ARCHITECTURE.md](ARCHITECTURE.md) for how the parts connect, and [CONTRIBUTING.md](CONTRIBUTING.md) to build and test.

## License

[MIT](LICENSE). Security reports: [SECURITY.md](SECURITY.md).
