import { mkdtempSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { LSP_SKILL, reconcileSkills } from "./skills.js";

// Minimal Services stub — reconcileSkills only reads workspace.root and calls files.write (mirrored here with a
// real on-disk write so the test can assert the file's presence/absence).
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

test("reconcile writes a skill when named and removes it when absent from the list", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    const skillPath = join(root, ".claude", "skills", "lsp", "SKILL.md");

    await reconcileSkills(services, ["lsp"]);
    expect(await readFile(skillPath, "utf8")).toBe(LSP_SKILL);

    await reconcileSkills(services, []);
    await expect(stat(skillPath)).rejects.toThrow();
});

test("reconcile with an empty list is a no-op when nothing was written", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    await expect(reconcileSkills(stubServices(root), [])).resolves.toBeUndefined();
});

test("an unknown skill name is ignored (no registry entry, nothing written)", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    await reconcileSkills(services, ["does-not-exist"]);
    await expect(stat(join(root, ".claude", "skills", "does-not-exist", "SKILL.md"))).rejects.toThrow();
});
