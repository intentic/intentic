import { mkdtempSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { LEGACY_ACCOUNT_SKILL_MARKER, loadedSkillDir, loadedSkillFile, stampSkill, skillWriterOf } from "../store/loaded-skills.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import { convergeAccountSkills } from "./account-skills.js";
import type { CapabilityCtx } from "./capability.js";

// The account skills sweep by their own stamp: what they wrote and no longer want goes, every other writer's skill and
// every unstamped file stays. Identities only, so no extension's pack is needed to render a skill.

const tempCtx = (capabilities: Capability[]) => {
    const root = mkdtempSync(join(tmpdir(), "account-skills-"));
    // What convergeAccountSkills reads; anything else it reached for would throw with its own name.
    const ctx = unstubbed<CapabilityCtx>("ctx", {
        workspace: unstubbed<CapabilityCtx["workspace"]>("workspace", { root }),
        files: unstubbed<CapabilityCtx["files"]>("files", { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath }),
        capabilities: unstubbed<CapabilityCtx["capabilities"]>("capabilities", { list: async () => capabilities }),
    });
    return { ctx, root };
};

const identity: Capability = { id: "main", kind: "identity", config: { email: "studio@gmail.com", openAccounts: "off" } };

const place = async (root: string, name: string, text: string): Promise<void> => {
    await mkdir(loadedSkillDir(root, name), { recursive: true });
    await writeFile(loadedSkillFile(root, name), text);
};

const present = async (root: string, name: string): Promise<boolean> =>
    stat(loadedSkillFile(root, name)).then(
        () => true,
        () => false,
    );

const skill = (name: string): string => `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\nBody.\n`;

test("the identities skill lands stamped as the account writer's, once, and a second converge leaves it as it is", async () => {
    const { ctx, root } = tempCtx([identity]);
    await convergeAccountSkills(ctx);
    const first = await readWorkspaceFile(loadedSkillFile(root, "identities"));
    expect(skillWriterOf(first ?? "")).toBe("account");
    expect(first?.match(/intentic:skill-writer=/g)?.length).toBe(1);

    await convergeAccountSkills(ctx);
    expect(await readWorkspaceFile(loadedSkillFile(root, "identities"))).toBe(first);
});

test("an account skill nothing wants is swept, under the new stamp or the one it carried before", async () => {
    const { ctx, root } = tempCtx([]);
    await place(root, "reddit", stampSkill(skill("reddit"), "account"));
    await place(root, "x", skill("x").replace("---\n\n", `---\n\n${LEGACY_ACCOUNT_SKILL_MARKER}\n\n`));

    await convergeAccountSkills(ctx);

    expect(await present(root, "reddit")).toBe(false);
    expect(await present(root, "x")).toBe(false);
});

test("a skill under the old account stamp that is still wanted is rewritten under the new one", async () => {
    const { ctx, root } = tempCtx([identity]);
    await place(root, "identities", skill("identities").replace("---\n\n", `---\n\n${LEGACY_ACCOUNT_SKILL_MARKER}\n\n`));

    await convergeAccountSkills(ctx);

    const text = await readWorkspaceFile(loadedSkillFile(root, "identities"));
    expect(text).not.toContain(LEGACY_ACCOUNT_SKILL_MARKER);
    expect(text).toContain("- `main`: studio@gmail.com");
    expect(skillWriterOf(text ?? "")).toBe("account");
});

test("the account sweep never touches another writer's skill or an unstamped one", async () => {
    const { ctx, root } = tempCtx([]);
    await place(root, "github", stampSkill(skill("github"), "cli"));
    await place(root, "approvals", stampSkill(skill("approvals"), "approvals"));
    await place(root, "mine", skill("mine"));

    await convergeAccountSkills(ctx);

    expect(await present(root, "github")).toBe(true);
    expect(await present(root, "approvals")).toBe(true);
    expect(await present(root, "mine")).toBe(true);
});
