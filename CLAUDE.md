- Do not create new git branches.
- No legacy support – make clean breaking changes; update all usages.
- No re-exports or aliases – import from the true source; use original names.
- No redundant assignments/coercions – avoid renaming, ?? null, or key renames without purpose.
- Let errors propagate – do not wrap/rethrow unchanged errors.
- No trivial wrappers – call signals, setters, and properties directly.
- Prefer undefined – use it consistently; avoid mixing with null.
- No migration logic – assume fresh state; remove compatibility layers.
- Use early returns – handle edge cases first.
- Treat rewriting as cheap - always go for best design, not the least disruptive change.

---
For the full architecture — the deployment engine, the app plane (web/api/sandbox), the extension
system, and the iq/lsp dependency islands — see [ARCHITECTURE.md](./ARCHITECTURE.md).