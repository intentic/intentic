import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { LSP_SKILL, listOwnSkills, ownSkillDir, ownSkillOn, readOwnSkill, reconcileBakedSkills, removeOwnSkill, switchOwnSkill, writeOwnSkill } from "./skills.js";

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

test("reconcile writes a baked tool when named and removes it when absent from the list", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    const skillPath = join(root, ".agents", "skills", "lsp", "SKILL.md");

    await reconcileBakedSkills(services, ["lsp"]);
    expect(await readFile(skillPath, "utf8")).toBe(LSP_SKILL);

    await reconcileBakedSkills(services, []);
    await expect(stat(skillPath)).rejects.toThrow();
});

test("reconcile with an empty list is a no-op when nothing was written", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    await expect(reconcileBakedSkills(stubServices(root), [])).resolves.toBeUndefined();
});

test("an unknown skill name is ignored (no registry entry, nothing written)", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    await reconcileBakedSkills(services, ["does-not-exist"]);
    await expect(stat(loadedPath(root, "does-not-exist"))).rejects.toThrow();
});

// The stored copy is the text, the loaded copy is the switch: off deletes only the copy, never the source.
test("an own skill's loaded copy follows its switch, and only the copy goes when off", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    const skill = { name: "release-notes", description: "Use when drafting release notes.", body: "Run git log." };
    await writeOwnSkill(services, skill);
    expect(await ownSkillOn(services, "release-notes")).toBe(false);

    await switchOwnSkill(services, skill, true);
    expect(await ownSkillOn(services, "release-notes")).toBe(true);
    expect(await readFile(loadedPath(root, "release-notes"), "utf8")).toContain("description: Use when drafting release notes.");

    await switchOwnSkill(services, skill, false);
    expect(await ownSkillOn(services, "release-notes")).toBe(false);
    await expect(stat(loadedPath(root, "release-notes"))).rejects.toThrow();
    expect(await readOwnSkill(services, "release-notes")).toEqual({
        name: "release-notes",
        description: "Use when drafting release notes.",
        body: "Run git log.\n",
    });
});

// The settings list names baked tools only: whatever it says, a reconcile neither creates, deletes nor rewrites an
// own skill. The loaded copy is the owner's file too, agent edits included.
test("a reconcile of the baked tools never touches an own skill, on or off", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    const notes = { name: "notes", description: "Use it.", body: "Body." };
    await writeOwnSkill(services, notes);
    await switchOwnSkill(services, notes, true);
    await writeOwnSkill(services, { name: "paused", description: "Later.", body: "Body." });
    await writeFile(loadedPath(root, "notes"), "---\nname: notes\ndescription: Edited in place.\n---\n\nBody two.\n");

    await reconcileBakedSkills(services, []);
    await reconcileBakedSkills(services, ["lsp", "notes", "paused"]);
    expect(await readFile(loadedPath(root, "notes"), "utf8")).toContain("Body two.");
    await expect(stat(loadedPath(root, "paused"))).rejects.toThrow();
});

test("removing an own skill clears the stored copy and the loaded one together", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    const notes = { name: "notes", description: "Use it.", body: "Body." };
    await writeOwnSkill(services, notes);
    await switchOwnSkill(services, notes, true);

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
