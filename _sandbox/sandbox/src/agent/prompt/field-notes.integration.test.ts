import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIELD_NOTES_FILE } from "@intentic/constants";
import { afterEach, expect, test } from "vitest";
import { fieldNotes } from "./field-notes.js";

// Pins the four properties that decide whether a truncated brief is safe to read: the index always rides, sections are
// taken whole in rank order, what was dropped is named, and a file whose index cannot be trusted sends nothing at all.

const dirs: string[] = [];

const scaffold = async (contents: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "field-notes-"));
    dirs.push(dir);
    await mkdir(join(dir, FIELD_NOTES_FILE, ".."), { recursive: true });
    await writeFile(join(dir, FIELD_NOTES_FILE), contents);
    return dir;
};

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const FILE = [
    `meta:`,
    `  title: Field notes`,
    `priority[3]{rank,id,title,cost}:`,
    `  1,ground,Which tree you are in,"edits land outside the branch, or in another agent's commit"`,
    `  2,toolchain,Binaries and the overlay,whole verification passes discarded`,
    `  3,owner,"The owner: how he asks","right code, wrong deliverable"`,
    `ground:`,
    `  check: git -C /work rev-parse --abbrev-ref HEAD`,
    `  rules[1]{rule}:`,
    `    "Read it; never write it, whatever an older note says."`,
    `toolchain:`,
    `  overlay: /work is ext4 and node_modules is an overlay mount`,
    `owner:`,
    `  vocabulary: He names routes, never directories`,
    ``,
].join("\n");

// The fixture's sections in rank order, each with one line only IT carries: the section keys themselves recur inside
// the index rows that name them, so every assertion below anchors on a body instead.
const SECTIONS = [
    { id: `ground`, body: `  check: git -C /work rev-parse --abbrev-ref HEAD` },
    { id: `toolchain`, body: `  overlay: /work is ext4 and node_modules is an overlay mount` },
    { id: `owner`, body: `  vocabulary: He names routes, never directories` },
];

// Ordered by each section's own body, never by its key: "owner:" also occurs inside the index row that names it
// ("The owner: how he asks"), so a key match would compare a position in the table against one in the sections.
test("meta rides and sections follow in rank order; the index is read, not sent", async () => {
    const root = await scaffold(FILE);
    const notes = fieldNotes({ root, budget: 10_000 });
    expect(notes?.ranksSent).toBe(3);
    // Read off the `priority` table even though the table itself never reaches the turn.
    expect(notes?.ranksTotal).toBe(3);
    const text = notes?.text ?? ``;
    expect(text).toContain(`  title: Field notes`);
    expect(text).not.toContain(`priority[3]`);
    const at = SECTIONS.map((section) => text.indexOf(section.body));
    expect(at.every((index) => index > 0)).toBe(true);
    expect(at).toEqual([...at].toSorted((left, right) => left - right));
});

test("the owner's own bytes survive: a section is sliced, never re-encoded", async () => {
    const root = await scaffold(FILE);
    const text = fieldNotes({ root, budget: 10_000 })?.text ?? ``;
    // The quoted comma is the giveaway — a re-encode would requote it, and a naive splitter would cut it in half.
    expect(text).toContain(`  rules[1]{rule}:\n    "Read it; never write it, whatever an older note says."`);
    expect(text).toContain(`  vocabulary: He names routes, never directories`);
});

// What must hold of the brief at ANY budget: provenance rides, the index does not (its prose columns cost more than
// the sections they describe), the sections present are exactly the top `sent` ranks present whole, and what was shed
// is named.
const holdsAt = (text: string, sent: number): void => {
    expect(text).toContain(`  title: Field notes`);
    expect(text).not.toContain(`priority[3]`);
    for (const [at, section] of SECTIONS.entries()) {
        expect(text.includes(`${section.id}:\n${section.body}`)).toBe(at < sent);
        expect(text.includes(section.body)).toBe(at < sent);
    }
    if (sent < SECTIONS.length) {
        expect(text).toContain(`ranks ${sent + 1}-${SECTIONS.length}`);
        expect(SECTIONS.slice(sent).every((section) => text.includes(section.id))).toBe(true);
    }
};

// `sent: -1` for "nothing came back", so a sweep over budgets reads one shape at every step and an absent brief fails
// the properties below rather than skipping them.
const notesAt = (root: string, budget: number): { readonly sent: number; readonly text: string } => {
    const notes = fieldNotes({ root, budget });
    return notes === undefined ? { sent: -1, text: `` } : { sent: notes.ranksSent, text: notes.text };
};

// Every budget the fixture can express, rather than three transcribed numbers: which budget sheds which section is
// arithmetic this test should not be repeating, and a sweep asserts the properties at all of them.
test("narrowing the budget sheds whole sections from the bottom rank up, and never half of one", async () => {
    const root = await scaffold(FILE);
    const whole = notesAt(root, 10_000);
    expect(whole.sent).toBe(3);
    const reached = new Set<number>();
    for (let budget = whole.text.length + 20; budget >= 0; budget -= 1) {
        const at = notesAt(root, budget);
        reached.add(at.sent);
        holdsAt(at.text, at.sent);
    }
    expect([...reached].toSorted((left, right) => left - right)).toEqual([0, 1, 2, 3]);
});

test("one file is one treatment: the revision tracks the file, not the budget", async () => {
    const root = await scaffold(FILE);
    expect(fieldNotes({ root, budget: 10_000 })?.revision).toBe(fieldNotes({ root, budget: 600 })?.revision);
    const moved = await scaffold(FILE.replace(`He names routes`, `He names routes and packages`));
    expect(fieldNotes({ root: moved, budget: 10_000 })?.revision).not.toBe(fieldNotes({ root, budget: 10_000 })?.revision);
});

test("no file is silence; a file with no usable index is a complaint and nothing sent", async () => {
    const empty = await mkdtemp(join(tmpdir(), "field-notes-"));
    dirs.push(empty);
    const quiet: string[] = [];
    expect(fieldNotes({ root: empty, budget: 10_000, onUnreadable: (why) => quiet.push(why) })).toBeUndefined();
    expect(quiet).toEqual([]);

    const said: string[] = [];
    const broken = await scaffold([`meta:`, `  title: Field notes`, `ground:`, `  check: ok`].join("\n"));
    expect(fieldNotes({ root: broken, budget: 10_000, onUnreadable: (why) => said.push(why) })).toBeUndefined();
    expect(said.join(" ")).toContain(`priority`);
});

test("an index naming a section the file lost sends nothing rather than a brief with a hole in it", async () => {
    const said: string[] = [];
    const root = await scaffold(FILE.replace(`toolchain:\n  overlay: /work is ext4 and node_modules is an overlay mount\n`, ``));
    expect(fieldNotes({ root, budget: 10_000, onUnreadable: (why) => said.push(why) })).toBeUndefined();
    expect(said.join(" ")).toContain(`toolchain`);
});
