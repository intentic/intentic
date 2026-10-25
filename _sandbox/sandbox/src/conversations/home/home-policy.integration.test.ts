import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { preambleNotes } from "../../sessions/vocabulary/prompt-envelope.js";
import { statePath } from "../../state-paths.js";
import { DEFAULT_HOME_POLICY, homeNoteIfDue, readHomePolicy } from "./home-policy.js";

// What a home conversation works by: the owner's own policy where they wrote one, the default otherwise, carried on the
// turns history cannot carry it to.

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});
const workspace = async (policy?: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-home-policy-"));
    roots.push(root);
    if (policy !== undefined) {
        const file = statePath(root, ".intentic/config/home.md");
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, policy);
    }
    return root;
};

test("the owner's own policy wins; an empty or missing one is the default", async () => {
    expect(await readHomePolicy(await workspace("Review everything twice.\n"))).toBe("Review everything twice.");
    expect(await readHomePolicy(await workspace("  \n"))).toBe(DEFAULT_HOME_POLICY);
    expect(await readHomePolicy(await workspace())).toBe(DEFAULT_HOME_POLICY);
});

test("the default delegates, judges before it merges, and asks a person only for what only a person can give", () => {
    expect(DEFAULT_HOME_POLICY).toContain('freshOf: { conversationId: <the subagent>, kind: "test" }');
    expect(DEFAULT_HOME_POLICY).toContain("Never merge work a review or a test found broken.");
    expect(DEFAULT_HOME_POLICY).toContain("what you merged lands in the workspace and is committed");
    expect(DEFAULT_HOME_POLICY).toContain("never ask your person to");
});

test("rides a home's opening turn and the one after a compaction, as its own note; nothing else carries it", async () => {
    const deps = { workspace: { root: await workspace() } };
    const note = await homeNoteIfDue(deps, { identity: { home: true } }, 0);
    expect(note?.title).toBe("How this home conversation works");
    expect(preambleNotes(`${note?.text}\n\n---\n\nhello`).map((each) => each.title)).toContain("How this home conversation works");
    expect(await homeNoteIfDue(deps, { identity: { home: true } }, 3)).toBeUndefined();
    expect(await homeNoteIfDue(deps, { identity: { home: true }, compactedTurn: 3 }, 3)).toMatchObject({ title: "How this home conversation works" });
    expect(await homeNoteIfDue(deps, { identity: {} }, 0)).toBeUndefined();
});
