import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { SKILL_FILE } from "../skill-file.js";
import { LEGACY_ACCOUNT_SKILL_MARKER, loadedSkillDir, loadedSkillFile, stampSkill, type SkillWriter } from "../store/loaded-skills.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import { retireSkills } from "./skill-retirement.js";

// The pass runs against real folders: what it must never do is delete, so the tests read what is left on disk and what
// landed in the history trash.

// The frontmatter the drafts skill shipped with before the queue became approvals (2026-09-02).
const SHIPPED_DRAFTS = `---
name: drafts
description: Create post drafts for owner approval by writing JSON files into .intentic/config/drafts/. Use whenever asked to prepare, draft, propose, or schedule posts (X, Reddit, YouTube, Discord, …) instead of posting immediately.
---

# Drafts
`;

const skill = (name: string): string => `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\nBody.\n`;

const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "skill-retire-"));
    const history = mkdtempSync(join(tmpdir(), "skill-retire-history-"));
    const services = {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile, write: writeWorkspaceFile, remove: removeWorkspacePath }),
    };
    return { root, history, services };
};

const place = async (root: string, name: string, text: string, writer: SkillWriter = "owner"): Promise<void> => {
    await mkdir(loadedSkillDir(root, name), { recursive: true });
    await writeFile(loadedSkillFile(root, name), stampSkill(text, writer));
};

const present = async (root: string, name: string): Promise<boolean> =>
    stat(loadedSkillFile(root, name)).then(
        () => true,
        () => false,
    );

const trashNames = async (history: string): Promise<string[]> => (await readdir(join(history, "trash")).catch(() => [])).toSorted();

test("a stamped skill no current writer claims goes to the history trash, never erased", async () => {
    const { root, history, services } = setup();
    // A baked tool a later release dropped from its registry, and a static writer's name it no longer writes.
    await place(root, "old-tool", skill("old-tool"), "baked-tool");
    await place(root, "old-approvals", skill("old-approvals"), "approvals");

    const pass = await retireSkills(services, history, () => 1_760_000_000_000);

    expect(pass.trashed.map((entry) => entry.name)).toEqual(["old-approvals", "old-tool"]);
    expect(pass.skipped).toEqual([]);
    expect(await present(root, "old-tool")).toBe(false);
    expect(await trashNames(history)).toEqual(["skill-old-approvals-1760000000000", "skill-old-tool-1760000000000"]);
    expect(await readFile(join(history, "trash", "skill-old-tool-1760000000000", SKILL_FILE), "utf8")).toBe(stampSkill(skill("old-tool"), "baked-tool"));
});

test("stamped skills their writer still claims stay, including every self-converging writer's", async () => {
    const { root, history, services } = setup();
    await place(root, "approvals", skill("approvals"), "approvals");
    await place(root, "lsp", skill("lsp"), "baked-tool");
    await place(root, "fileq", skill("fileq"), "baked-tool");
    await place(root, "ssh", skill("ssh"), "ssh");
    await place(root, "github", skill("github"), "cli");
    await place(root, "omen", skill("omen"), "peer");
    await place(root, "reddit", skill("reddit"), "account");
    await place(root, "tailscale", skill("tailscale"), "tunnel");

    const pass = await retireSkills(services, history);

    expect(pass).toEqual({ trashed: [], kept: 8, skipped: [] });
    expect(await trashNames(history)).toEqual([]);
});

test("an unstamped skill is the owner's and stays, whatever its name", async () => {
    const { root, history, services } = setup();
    await place(root, "my-writing-style", skill("my-writing-style"));
    await place(root, "old-tool", skill("old-tool"));

    expect(await retireSkills(services, history)).toEqual({ trashed: [], kept: 2, skipped: [] });
    expect(await present(root, "old-tool")).toBe(true);
});

test("the retired drafts skill goes to the trash when its text is the one intentic shipped", async () => {
    const { root, history, services } = setup();
    await place(root, "drafts", SHIPPED_DRAFTS);

    const pass = await retireSkills(services, history, () => 1_760_000_000_000);

    expect(pass.trashed).toEqual([
        {
            name: "drafts",
            to: join(history, "trash", "skill-drafts-1760000000000"),
            why: "the drafts queue became approvals on 2026-09-02 (approvals/approvals-store.ts); its skill is the approvals skill",
        },
    ]);
    expect(await present(root, "drafts")).toBe(false);
    expect(await readFile(join(history, "trash", "skill-drafts-1760000000000", SKILL_FILE), "utf8")).toBe(SHIPPED_DRAFTS);
});

test("an owner's own drafts skill, with text of its own, stays", async () => {
    const { root, history, services } = setup();
    await place(root, "drafts", "---\nname: drafts\ndescription: My blog drafts live in ~/blog; use when I say draft.\n---\n\nMine.\n");

    expect(await retireSkills(services, history)).toEqual({ trashed: [], kept: 1, skipped: [] });
    expect(await present(root, "drafts")).toBe(true);
});

test("a stamp naming a writer this release does not know is doubt, and stays", async () => {
    const { root, history, services } = setup();
    // What a newer release's writer leaves behind, seen after a rollback.
    await mkdir(loadedSkillDir(root, "future"), { recursive: true });
    await writeFile(
        loadedSkillFile(root, "future"),
        skill("future").replace("---\n\n", "---\n\n<!-- intentic:skill-writer=future-writer · written by the sandbox; edits here are overwritten -->\n\n"),
    );

    expect(await retireSkills(services, history)).toEqual({ trashed: [], kept: 1, skipped: [] });
});

test("an account skill under the stamp it carried before every writer had one is still the account writer's, and stays", async () => {
    const { root, history, services } = setup();
    await place(root, "reddit", skill("reddit").replace("---\n\n", `---\n\n${LEGACY_ACCOUNT_SKILL_MARKER}\n\n`));

    expect(await retireSkills(services, history)).toEqual({ trashed: [], kept: 1, skipped: [] });
});

test("a skill folder whose file does not read is skipped and reported, never removed", async () => {
    const { root, history, services } = setup();
    await mkdir(loadedSkillDir(root, "half-written"), { recursive: true });

    const pass = await retireSkills(services, history);

    expect(pass).toEqual({ trashed: [], kept: 0, skipped: [{ name: "half-written", why: "SKILL.md missing or unreadable" }] });
    expect((await stat(loadedSkillDir(root, "half-written"))).isDirectory()).toBe(true);
});

test("a loaded folder that cannot be listed fails the pass whole instead of reading as empty", async () => {
    const { root, history, services } = setup();
    await place(root, "old-tool", skill("old-tool"), "baked-tool");
    const skills = join(root, ".agents", "skills");
    await rm(skills, { recursive: true, force: true });
    // A link to itself: listing it fails with ELOOP, not ENOENT, whoever runs the test.
    await symlink(skills, skills);

    await expect(retireSkills(services, history)).rejects.toMatchObject({ code: "ELOOP" });
    expect(await trashNames(history)).toEqual([]);
});
