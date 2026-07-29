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
- Fix the pattern, not the instance – trace a bug to its root cause; when the same knowledge lives in N
  places, extract one source of truth and make every consumer import it (or execute what it emits).
- Guard invariants by discovery, not enumeration – a test that recognizes violations by their SHAPE anywhere
  in the repo; a hardcoded file list repeats the miss it exists to prevent.

---
For the full architecture — the app plane (web/api/sandbox) that is the product, the extension
system, the iq/lsp dependency islands, and the bundled deployment-engine tool — see
[ARCHITECTURE.md](./ARCHITECTURE.md).