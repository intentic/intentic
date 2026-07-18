import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Services } from "../composition.js";

// Baked-tool skills the daemon loads into the agent's .claude/skills on demand. The tool binaries are always on
// PATH (baked by the Dockerfile); the SKILL.md is what actually surfaces a tool to the agent, so writing it gates
// the feature and keeps it out of the prompt otherwise. Which skills are present is driven by the settings
// `skills` array (SandboxSettings) — adding a new baked tool is one registry entry here + its name in that array,
// with no settings-contract change.

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

// skill name → SKILL.md body. The settings `skills` array selects which of these are written to disk.
const SKILLS: Record<string, string> = {
    lsp: LSP_SKILL,
};

const skillDir = (root: string, name: string): string => join(root, ".claude", "skills", name);

// Converge every known skill against the enabled list: written when its name is present (so the agent learns the
// CLI), removed otherwise. Called at boot and after every settings save, so a change takes effect on the next
// turn without a restart. An enabled name with no registry entry is ignored (nothing to write).
export const reconcileSkills = async (services: Services, enabled: readonly string[]): Promise<void> => {
    for (const [name, body] of Object.entries(SKILLS)) {
        const dir = skillDir(services.workspace.root, name);
        if (enabled.includes(name)) {
            await services.files.write(join(dir, "SKILL.md"), body);
            continue;
        }
        await rm(dir, { recursive: true, force: true });
    }
};
