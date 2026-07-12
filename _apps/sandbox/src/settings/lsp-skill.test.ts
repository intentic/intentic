import { mkdtempSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { LSP_SKILL, reconcileLspSkill } from "./lsp-skill.js";

// Minimal Services stub — reconcileLspSkill only reads workspace.root and calls files.write (mirrored here with
// a real on-disk write so the test can assert the file's presence/absence).
const stubServices = (root: string): Services =>
    ({
        workspace: { root },
        files: {
            write: async (path: string, content: string) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, content);
            },
        },
    }) as unknown as Services;

test("reconcile writes the lsp skill when enabled and removes it when disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-skill-"));
    const services = stubServices(root);
    const skillPath = join(root, ".claude", "skills", "lsp", "SKILL.md");

    await reconcileLspSkill(services, true);
    expect(await readFile(skillPath, "utf8")).toBe(LSP_SKILL);

    await reconcileLspSkill(services, false);
    await expect(stat(skillPath)).rejects.toThrow();
});

test("reconcile disabling is a no-op when the skill was never written", async () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-skill-"));
    await expect(reconcileLspSkill(stubServices(root), false)).resolves.toBeUndefined();
});
