# The editor

The editor is the screen the user works in, with files, chat, terminals and agents, built as one web app that desktop, iOS and Android shells open.

```mermaid
flowchart LR
    desktop["desktop-app<br/>Tauri window"] --> web(["web<br/>the editor"])
    ios["ios-app<br/>Capacitor shell"] --> web
    android["android-app<br/>native: Kotlin views"] --> core(["mobile-core<br/>Rust client"])
    core --> daemon
    core --> api
    android -.->|"long tail in a WebView"| web
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
| [android-app](android-app) | Native Android app: Kotlin views over the Rust core, the web editor in a WebView for the long tail. |
| [mobile-core](mobile-core) | Rust core of the native app: sessions, the daemon's streams, the local store, rendered rows. |
| [android-native](android-native) | The spike and bench that chose the native app's stack, measured on a Galaxy S10. |
| [share-view](share-view) | Read-only page a shared conversation is published as. |
