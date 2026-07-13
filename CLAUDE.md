- Work only on the current branch.
- No legacy support – make clean breaking changes; update all usages.
- No re-exports or aliases – import from the true source; use original names. Exception: each package's `src/index.ts` is its public npm entrypoint; internal cross-package imports still go to the true source via the `@intentic/src` condition.
- No redundant assignments/coercions – avoid renaming, ?? null, or key renames without purpose.
- Let errors propagate – do not wrap/rethrow unchanged errors.
- No trivial wrappers – call signals, setters, and properties directly.
- Prefer undefined – use it consistently; avoid mixing with null.
- No migration logic – assume fresh state; remove compatibility layers.
- Use early returns – handle edge cases first.

---
For the full architecture — the deployment engine, the app plane (web/api/sandbox), the extension
system, and the iq/lsp dependency islands — see [ARCHITECTURE.md](./ARCHITECTURE.md).