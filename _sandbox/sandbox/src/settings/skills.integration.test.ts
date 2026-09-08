import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { LSP_SKILL, listOwnSkills, ownSkillDir, readOwnSkill, reconcileSkills, removeOwnSkill, writeOwnSkill } from "./skills.js";

// Minimal services stub with real on-disk IO, so assertions match what the agent's loader would actually find.
const stubServices = (root: string): Services =>
    unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", {
            read: (path) => readFile(path, "utf8").catch(() => undefined),
            write: async (path, content) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, content);
            },
            remove: (path) => rm(path, { recursive: true, force: true }),
        }),
    });

const loadedPath = (root: string, name: string): string => join(root, ".agents", "skills", name, "SKILL.md");

test("reconcile writes a skill when named and removes it when absent from the list", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    const skillPath = join(root, ".agents", "skills", "lsp", "SKILL.md");

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
    await expect(stat(loadedPath(root, "does-not-exist"))).rejects.toThrow();
});

// Storing own skills separately from the loaded copy means switching one off deletes only the copy, never the source.
test("an own skill is copied into the loaded folder when on, and only the copy goes when off", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    await writeOwnSkill(services, { name: "release-notes", description: "Use when drafting release notes.", body: "Run git log." });

    await reconcileSkills(services, ["release-notes"]);
    expect(await readFile(loadedPath(root, "release-notes"), "utf8")).toContain("description: Use when drafting release notes.");

    await reconcileSkills(services, []);
    await expect(stat(loadedPath(root, "release-notes"))).rejects.toThrow();
    expect(await readOwnSkill(services, "release-notes")).toEqual({
        name: "release-notes",
        description: "Use when drafting release notes.",
        body: "Run git log.\n",
    });
});

// Reconcile re-reads own skills from disk every pass, so an out-of-band edit (the agent's own file tools) reaches the
// next turn.
test("reconcile picks up an out-of-band edit to a stored skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    await writeOwnSkill(services, { name: "notes", description: "First.", body: "Body one." });
    await reconcileSkills(services, ["notes"]);

    await writeFile(join(ownSkillDir(root, "notes"), "SKILL.md"), "---\nname: notes\ndescription: Second.\n---\n\nBody two.\n");
    await reconcileSkills(services, ["notes"]);
    expect(await readFile(loadedPath(root, "notes"), "utf8")).toContain("Body two.");
});

test("removing an own skill clears the stored copy and the loaded one together", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    await writeOwnSkill(services, { name: "notes", description: "Use it.", body: "Body." });
    await reconcileSkills(services, ["notes"]);

    await removeOwnSkill(services, "notes");
    await expect(stat(loadedPath(root, "notes"))).rejects.toThrow();
    expect(await readOwnSkill(services, "notes")).toBeUndefined();
    expect(await listOwnSkills(services)).toEqual([]);
});

// A directory with no readable SKILL.md is half-written, not an empty skill; it's excluded rather than listed blank.
test("a stored directory with no SKILL.md is not listed", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    await mkdir(ownSkillDir(root, "half-written"), { recursive: true });
    expect(await listOwnSkills(services)).toEqual([]);
});
