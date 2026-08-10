import { mkdtempSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { LSP_SKILL, listOwnSkills, ownSkillDir, readOwnSkill, reconcileSkills, removeOwnSkill, writeOwnSkill } from "./skills.js";

// Minimal Services stub — the skill store reads workspace.root and goes through files.read/write (mirrored here
// with real on-disk IO so the tests can assert what the agent's loader would actually find).
const stubServices = (root: string): Services =>
    unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", {
            read: (path) => readFile(path, "utf8").catch(() => undefined),
            write: async (path, content) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, content);
            },
        }),
    });

const loadedPath = (root: string, name: string): string => join(root, ".claude", "skills", name, "SKILL.md");

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
    await expect(stat(loadedPath(root, "does-not-exist"))).rejects.toThrow();
});

/* THE WHOLE POINT OF STORING OWN SKILLS SEPARATELY: switching one off must not delete what was written. Storing
 * them in the loaded folder would have made "off" and "gone" the same operation, which is the mistake this layout
 * exists to prevent — so this test asserts both halves, the copy disappearing AND the source surviving. */
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

// The reconciler reads own skills off disk on every pass rather than taking them as arguments, so that an edit
// made out-of-band — by the agent's own file tools, mid-session — reaches the next turn.
test("reconcile picks up an out-of-band edit to a stored skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    await writeOwnSkill(services, { name: "notes", description: "First.", body: "Body one." });
    await reconcileSkills(services, ["notes"]);

    await writeFile(join(ownSkillDir(root, "notes"), "SKILL.md"), "---\nname: notes\ndescription: Second.\n---\n\nBody two.\n");
    await reconcileSkills(services, ["notes"]);
    expect(await readFile(loadedPath(root, "notes"), "utf8")).toContain("Body two.");
});

// Deleting is the one operation that has to reach BOTH copies: leaving the loaded one behind would keep a deleted
// skill in the agent's context until something else happened to reconcile it away.
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

// A directory with no readable SKILL.md is a half-written skill, not one that does nothing — listing it empty would
// put a row with no description in front of the reader and imply the agent had been handed it.
test("a stored directory with no SKILL.md is not listed", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const services = stubServices(root);
    await mkdir(ownSkillDir(root, "half-written"), { recursive: true });
    expect(await listOwnSkills(services)).toEqual([]);
});
