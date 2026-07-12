import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Services } from "../composition.js";

// The `lsp` CLI (baked on PATH by the Dockerfile) drives the TypeScript language service for rename + diagnostics.
// The binary is always present, but this skill — what actually makes the agent reach for it — is written only
// while the lspTools toggle is on, so gating the skill gates the feature and keeps it out of the prompt otherwise.
export const LSP_SKILL = `---
name: lsp
description: Rename a TypeScript/JavaScript symbol across the project and read compiler diagnostics with the \`lsp\` CLI. Use whenever renaming a symbol, refactoring code other files import, or checking a file for type errors without a full build.
---

# lsp — TypeScript rename & diagnostics

The \`lsp\` CLI (on PATH) drives the TypeScript language service. Prefer it over hand-editing imports or eyeballing types — it updates every usage and reports real compiler errors.

## Rename a symbol (updates every usage)
\`lsp rename <file> <symbolName> <newName>\`
- Renames the declaration and every reference across the file's TypeScript project — imports, exports, and call sites all move together, so you never leave a dangling old name or introduce an alias.
- \`<file>\` is the file that DECLARES the symbol; \`<symbolName>\` is its current name.
- Example: \`lsp rename src/user.ts getUser fetchUser\`
- Scope: the invoked file's own tsconfig project. For a symbol also used in OTHER packages of a monorepo, run \`lsp rename\` in each package that declares/re-exports it, then \`lsp diag\` the consumers to catch any stragglers.

## Check files for errors
\`lsp diag <file...>\`
- Prints syntactic + semantic diagnostics as \`path:line:col: error TS<code>: message\`; "no diagnostics" means the file type-checks. Faster than a full build for confirming an edit is sound — run it after edits to verify you updated all usages.

Notes: TypeScript/JavaScript only. Pass workspace paths.
`;

const lspSkillDir = (root: string): string => join(root, ".claude", "skills", "lsp");

// Converge the lsp skill with the lspTools toggle: written (so the agent learns the CLI) when on, removed when
// off. Mirrors ensureDraftsSkill, but reconciled against the flag instead of always present. Called at boot and
// after every settings save, so a toggle takes effect on the next turn without a restart.
export const reconcileLspSkill = async (services: Services, enabled: boolean): Promise<void> => {
    if (enabled) {
        await services.files.write(join(lspSkillDir(services.workspace.root), "SKILL.md"), LSP_SKILL);
        return;
    }
    await rm(lspSkillDir(services.workspace.root), { recursive: true, force: true });
};
