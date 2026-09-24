# Your devices

The parts of intentic that run on a user's own computer and browser, letting a sandbox's agent work there within the switches the owner set.

```mermaid
flowchart LR
    subgraph device["User's device"]
        launch["win-launcher<br/>starts it at logon"] --> machine["machine<br/>intentic-machine"]
        machine --> libs["browser<br/>desktop-automation<br/>local-agent"]
        webext["webext<br/>in the user's Chrome"]
    end
    machine -->|"outbound WebSocket<br/>device tools"| daemon["Sandbox daemon"]
    machine -->|"Mutagen over SSH tunnel<br/>folder and ports"| daemon
    webext -->|"outbound WebSocket<br/>page tools"| daemon
```

| Package | Role |
| --- | --- |
| [machine](machine) | The device agent: sandbox tools, folder sync and port mirroring. |
| [webext](webext) | Chrome extension letting the agent work in the user's signed-in browser. |
| [browser](browser) | Drives a separate Chromium profile over CDP for the machine. |
| [desktop-automation](desktop-automation) | Screen capture, pointer, keyboard and windows on Windows and Linux. |
| [local-agent](local-agent) | State directory, login autostart and pidfiles for on-device CLIs. |
| [win-launcher](win-launcher) | Starts an agent on Windows without a console window. |
