# The sandbox

One private box per project where the code and its coding agents live, owned by the `sandbox` daemon and reached from the editor, CI, websites and the user's devices.

```mermaid
flowchart LR
    editor["Editor<br/>web · desktop · mobile"] --> netd["netd<br/>ports · tunnel"]
    acp["acp-bridge on a device<br/>Zed · JetBrains"] --> netd
    embeds["webchat-widget · issue-sdk<br/>on a website"] --> netd
    ci["gate · gate-action<br/>in CI"] --> netd
    ic["ic<br/>host CLI"] -->|"starts · updates"| netd
    netd -->|"Unix socket"| daemon(["sandbox daemon"])
    daemon --> agents["Agents in worktrees"]
    agents --> tools["fileq · webq · ocr<br/>agent CLIs"]
```

The acp-bridge in the diagram runs on the user's device, so it lives in [_devices/acp-bridge](../_devices/acp-bridge). The install recipe the daemon shares with the browser's folder upload is [_shared/workspace-setup](../_shared/workspace-setup). The packages here:

| Package | Role |
| --- | --- |
| [agent-context](agent-context) | What an agent is told as a session opens (project map, field notes) and the readings that measure it |
| [claude-plugin](claude-plugin) | The `intentic` Claude Code plugin: trimmed Bash output, session context, fileq and iq, measured savings |
| [fileq](fileq) | Agent CLI reading binary files (docx, pdf, images, archives) as budgeted markdown |
| [netd](netd) | Rust network daemon: owns every port and the tunnel, supervises the daemon |
| [gate](gate) | `intentic-gate`: a CI pipeline waits on a release gate's verdict |
| [gate-action](gate-action) | GitHub Action: wait on a release gate or wake an automation |
| [ic](ic) | Rust host CLI: run, update and repair sandboxes, runners and deploy targets |
| [issue-sdk](issue-sdk) | Bug reporter a site embeds to send crashes to a sandbox agent |
| [ocr](ocr) | `ocr`: the text on an image read on this machine (PP-OCRv6), the privacy shield's reader |
| [output-cleaners](output-cleaners) | Trims agent Bash output, keeps the raw text retrievable, and ledgers each cleaner's saving |
| [sandbox](sandbox) | The daemon: runs agents in worktrees, serves the workspace, lands their work |
| [scaffold](scaffold) | Intent-repo skeleton, template scaffolding and `deploy.config` rendering for CLI and daemon |
| [webchat-widget](webchat-widget) | Visitor chat widget a site embeds to talk to a sandbox agent |
| [webq](webq) | Agent CLI fetching web pages as budgeted markdown, with bounded crawls |
