# The editor

The editor is the screen the user works in, with files, chat, terminals and agents, built as one web app that desktop, iOS and Android shells open.

```mermaid
flowchart LR
    desktop["desktop-app<br/>Tauri window"] --> web(["web<br/>the editor"])
    ios["ios-app<br/>Capacitor shell"] --> web
    android["android-app<br/>Trusted Web Activity"] --> web
    ui["ui<br/>components · theme · i18n"] -.->|"compiled in"| web
    web --> api["Platform api"]
    web --> daemon["Sandbox daemon"]
    desktop -->|"starts a local one"| daemon
    daemon -->|"publishes a share"| share["share-view<br/>public page"]
    ui -.->|"compiled in"| share
```

| Package | Role |
| --- | --- |
| [web](web) | The editor: Vue app talking to the platform api and the sandbox daemon. |
| [ui](ui) | Shared Vue components, composables, theme and i18n for every editor surface. |
| [desktop-app](desktop-app) | Tauri app that runs a local sandbox and opens the editor. |
| [ios-app](ios-app) | Capacitor shell around the hosted editor, adding native push. |
| [android-app](android-app) | Bubblewrap Trusted Web Activity around the hosted editor. |
| [share-view](share-view) | Read-only page a shared conversation is published as. |
