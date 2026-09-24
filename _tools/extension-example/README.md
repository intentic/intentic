# extension-example

Holds `seed/`, the reference intentic extension with one contribution of every kind, which is copied out as the standalone `intentic/extension-example` repository authors start from.

```mermaid
flowchart LR
    checks["This repository's checks<br/>manifest schema, templates"] --> seed(["seed/"])
    seed -->|"copied out"| repo["github.com/intentic/<br/>extension-example"]
    repo --> registry["Extension registry<br/>intentic.example"]
    registry --> sandbox["A sandbox<br/>installs a pinned commit"]
```

- `seed/` is a complete standalone project with its own `package.json` and `pnpm-workspace.yaml`. It is not a
  workspace package here, so this monorepo never installs, builds or tests it.
- The monorepo still reads it: `_editor/web`'s `manifest-schema.test.ts` validates its manifest against the current
  schema, and the `vue-templates` and `contract-paths` checks hold its source to the same rules as the app's.
- Its links are written for the copy, so the `md-links` check skips them. [seed/README.md](seed/README.md) is
  written for the extension author.
- The site's registry fallback lists the published copy as `intentic.example`.
