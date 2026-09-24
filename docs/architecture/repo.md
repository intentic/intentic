# intentic, in pictures

The parts of this repository and how they meet at runtime, drawn three ways: what talks to what, one agent turn, and where each part runs.

## What talks to what

```mermaid
flowchart LR
    owner["Owner"] --> editor["The editor<br/>_editor"]
    editor -->|"sign-in · sandbox list"| platform["Account<br/>_platform"]
    editor -->|"sandbox contract"| sandbox(["The sandbox<br/>_sandbox"])
    extensions["Extensions<br/>_extensions"] --- sandbox
    devices["Your devices<br/>_devices"] -->|"dial in"| sandbox
    sandbox --> search["Code search<br/>_search"]
    sandbox -->|"runs as a tool"| deploy["Deployment engine<br/>_deploy"]
    site["The website<br/>_site"] -.->|"plays a demo of"| editor
```

The lines are contracts in [`_shared`](../../_shared): the sandbox contract between the editor and the daemon, the api contract between the editor and the platform, and the extension API between extensions and both. [`_tools`](../../_tools) holds no runtime part; it builds, checks and tests the others. [topology.md](topology.md) has the processes and the trust model, [app-plane.md](app-plane.md) the line between the product and the deployment engine.

## One agent turn

```mermaid
sequenceDiagram
    participant O as Owner
    participant E as Editor
    participant D as Daemon
    participant A as Agent runtime
    participant S as iq
    O->>E: sends a message
    E->>D: POST /agent
    D->>A: starts the turn in its worktree
    A->>S: finds the right files
    A->>D: edits, each one checked
    D->>D: turn checks, then land
    D-->>E: events, diff, verdict
```

The turn runs detached from the browser, so closing the tab does not stop it. Landing writes the agent's changes into the main tree as uncommitted changes, and the owner's commit is the review. [sandbox.md](sandbox.md) has the details.

## Where each part runs

```mermaid
flowchart TB
    subgraph client["Owner's browser, desktop or phone"]
        editor["Editor"]
    end
    subgraph cloud["intentic's services"]
        api["Platform api"]
        ingress["Ingress"]
        site["Website"]
    end
    subgraph box["A sandbox container, on the owner's machine or hosted"]
        daemon(["Daemon"])
        tools["iq · fileq · webq<br/>intentic CLI"]
    end
    devices["Owner's computers<br/>and browser"]
    servers["Owner's servers"]
    editor --> api
    editor --> ingress --> daemon
    daemon --- tools
    devices --> ingress
    tools --> servers
```

The platform never opens a connection to a sandbox. The sandbox dials out to the ingress, and browsers and devices reach it by its own hostname.
