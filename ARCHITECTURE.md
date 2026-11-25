# Architecture

The index into [`docs/architecture/`](docs/architecture), where each page explains one subject of how intentic is put together.

```mermaid
flowchart LR
    editor["Editor<br/>browser · desktop · phone"] -->|"sign-in"| platform["Platform<br/>api · ingress"]
    editor -->|"sandbox contract"| daemon(["Sandbox daemon"])
    daemon --> agents["Agents<br/>one worktree each"]
    extensions["Extensions"] --- daemon
    devices["Your devices"] -->|"dial in"| daemon
    agents --> agenttools["Agent tools<br/>lsp · fileq · webq"]
    site["Website · demo"] -.-> editor
```

- [repo.md](docs/architecture/repo.md): the whole repository in pictures, from the parts listed in [repo.json](docs/architecture/repo.json).
- [topology.md](docs/architecture/topology.md): the processes and machines, which way each connection opens, and who can reach what.
- [sandbox.md](docs/architecture/sandbox.md): the daemon inside a sandbox, from agents and worktrees to landing, checks and state directories.
- [platform.md](docs/architecture/platform.md): the hosted account service, its registry and the hosted machines it runs.
- [app-plane.md](docs/architecture/app-plane.md): what counts as the product, and how one editor release drives daemons of any age.
- [extensions.md](docs/architecture/extensions.md): how extensions are packaged, loaded and kept to what they declare.
- [core-and-extensions.md](docs/architecture/core-and-extensions.md): what belongs in the core and what in a feature's extension, the API gaps that pull policy into the core, and the cases that set the line.
- [capabilities.md](docs/architecture/capabilities.md): connectors, accounts and machines, the catalog they come from, and where their credentials live.
- [access.md](docs/architecture/access.md): who a turn acts for (people and services), the access profiles that bound them, and the roles held to them.
- [accounts.md](docs/architecture/accounts.md): what one signed-in account reaches across every sandbox it is in, who knows each edge, and how the editor joins them into the access map.
- [needs.md](docs/architecture/needs.md): how an agent asks a person for a connection, a secret, access or a tool, and how the answer finds the conversation again.
- [convergence.md](docs/architecture/convergence.md): how containers, sync sessions, records, tunnels and hosted apps left behind return to the current shape by themselves, and the six rules every component follows for it.
- [os.md](docs/architecture/os.md): Intentic OS, the bootc image a machine boots straight into, and who may update, reboot or roll it back.
- [packages.md](docs/architecture/packages.md): the `_area/package` layout, package naming, the `@intentic/src` export condition, build and typecheck.
- [conventions.md](docs/architecture/conventions.md): the rules the repository's checks and linter enforce.
- [testing.md](docs/architecture/testing.md): test tiers, the `suites` runner, and where each tier runs.
- [languages.md](docs/architecture/languages.md): the editor's UI languages, message catalogs and the checks that keep them complete.

Package-level detail lives in each package's own README. [docs/README.md](docs/README.md) says which document belongs where.
