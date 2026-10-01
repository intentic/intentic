import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_FILE } from "@intentic/constants";
import { convergeProjectNote, PROJECT_NOTE_FENCE, projectNote } from "./project-note.js";

// Against a real workspace root on disk: the file is the owner's, and what this may never do is lose a byte of it.

const NAME = "my-app";

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const workspaceRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "project-note-"));
    tempDirs.push(root);
    return root;
};

// The block as it sits in the file, derived from the note this build writes.
const fenced = (root: string): string =>
    `<!-- ${PROJECT_NOTE_FENCE}:start -->\n${projectNote(join(root, NAME))}\n<!-- ${PROJECT_NOTE_FENCE}:end -->`;

// Copy-first, the default, keeps an agent's changes here until the owner brings them back. Under the two-way sync an
// owner can opt into, a bulk deletion inside it reaches their disk whole: the git pointer file the folder keeps here is
// sync-ignored but still counts as content, so Mutagen's halt on a one-sided root emptying never fires (measured against
// Mutagen 0.18.1). The note says the first and keeps the warning the second needs.
test("the note names the folder, what copy-first means, what two-way would carry, where its history is, and where to work", () => {
    expect(projectNote("/work/my-app")).toBe(
        "## The owner's project folder\n\n" +
            "`/work/my-app` is a copy of the owner's own folder on their computer. Their edits arrive here as they make them; " +
            "what you change here stays in the sandbox until they bring it back, after a restore point, and a file you " +
            "delete is put back from their copy. If they have switched this folder to two-way sync, an edit made here is on " +
            "their disk at once and so is a deletion: clearing it out (`rm -rf` of what it holds, `git clean`, `git stash -u`, " +
            "`git reset --hard`) would clear their copy, so never do that unless they ask. Its git history stays on their " +
            "computer. The sandbox tracks the folder in a repository of its own, so their commits and branches are not here, " +
            "and nothing committed here reaches theirs. Work inside it, not at the workspace root, unless they ask otherwise.",
    );
});

test("a workspace with no AGENTS.md gets one holding the note alone", async () => {
    const root = await workspaceRoot();

    expect(await convergeProjectNote(root, NAME)).toBe(true);

    expect(await readFile(join(root, MEMORY_FILE), "utf8")).toBe(`${fenced(root)}\n`);
});

test("the owner's own rules stay exactly as they were, with the note after them", async () => {
    const root = await workspaceRoot();
    await writeFile(join(root, MEMORY_FILE), "# House rules\n\nTabs, never spaces.\n");

    expect(await convergeProjectNote(root, NAME)).toBe(true);

    expect(await readFile(join(root, MEMORY_FILE), "utf8")).toBe(`# House rules\n\nTabs, never spaces.\n\n${fenced(root)}\n`);
});

// Every boot converges it; one that finds it current must not write, or the file reads as changed in every review.
test("a second boot finds the note current and leaves the file untouched", async () => {
    const root = await workspaceRoot();
    await writeFile(join(root, MEMORY_FILE), "# House rules\n");
    await convergeProjectNote(root, NAME);
    const before = await stat(join(root, MEMORY_FILE));
    const text = await readFile(join(root, MEMORY_FILE), "utf8");

    expect(await convergeProjectNote(root, NAME)).toBe(false);

    expect((await stat(join(root, MEMORY_FILE))).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(join(root, MEMORY_FILE), "utf8")).toBe(text);
});

// A release that rewords the note replaces its own block where it stands; what the owner wrote on either side stays.
test("an earlier release's note is replaced in place, the owner's lines around it kept", async () => {
    const root = await workspaceRoot();
    const earlier = `<!-- ${PROJECT_NOTE_FENCE}:start -->\n## Old wording\n<!-- ${PROJECT_NOTE_FENCE}:end -->`;
    await writeFile(join(root, MEMORY_FILE), `# House rules\n\n${earlier}\n\nAdded by the owner after it.\n`);

    expect(await convergeProjectNote(root, NAME)).toBe(true);

    expect(await readFile(join(root, MEMORY_FILE), "utf8")).toBe(`# House rules\n\n${fenced(root)}\n\nAdded by the owner after it.\n`);
});
