import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SAFETY_POLICY } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fileSafetyPolicyStore, withAddedLine } from "./safety-policy-store.js";

const store = async () => {
    const dir = await mkdtemp(join(tmpdir(), "safety-"));
    const path = join(dir, "safety.md");
    return { path, policy: fileSafetyPolicyStore(path) };
};

// Absent is not unconfigured: the shipped text describes the posture a workspace already has, so the judge reads a real
// policy on the first turn rather than an empty string meaning "ask about nothing".
test("with no file, it reads as the shipped default and says it is not the owner's own", async () => {
    const { policy } = await store();
    expect(await policy.get()).toEqual({ text: DEFAULT_SAFETY_POLICY, custom: false });
    expect(await policy.text()).toBe(DEFAULT_SAFETY_POLICY);
});

test("what the owner wrote comes back verbatim, and is reported as theirs", async () => {
    const { policy } = await store();
    await policy.set(`Ask me before anything.`);
    expect(await policy.get()).toEqual({ text: `Ask me before anything.\n`, custom: true });
});

// An empty file is a policy, not a missing one: it means "ask about nothing beyond the hard rule". Falling back to the
// default here would silently reinstate rules the owner deleted on purpose.
test("an emptied file is the owner's own policy, not a fallback to the default", async () => {
    const { path, policy } = await store();
    await writeFile(path, ``, "utf8");
    expect(await policy.get()).toEqual({ text: ``, custom: true });
});

// Every write ends in exactly one newline: a document that gets appended to has to know where its last line ended, and
// "sometimes" is how two headings end up on one line three appends later.
test("a save is newline-terminated exactly once", async () => {
    const { path, policy } = await store();
    await policy.set(`One line.`);
    expect(await readFile(path, "utf8")).toBe(`One line.\n`);
    await policy.set(`One line.\n`);
    expect(await readFile(path, "utf8")).toBe(`One line.\n`);
});

// The card's Always button, end to end: appends to the shipped text when there's no file yet, since clicking a card
// button isn't asking to throw away the default posture.
test("appending to a workspace with no file keeps the default and adds the line under it", async () => {
    const { policy } = await store();
    await policy.append(`Deleting build directories under /work is fine.`);
    const { text, custom } = await policy.get();
    expect(custom).toBe(true);
    expect(text).toContain(DEFAULT_SAFETY_POLICY.trimEnd());
    expect(text).toContain(`- Deleting build directories under /work is fine.`);
});

test("a second line joins the first instead of starting a second section", async () => {
    const { policy } = await store();
    await policy.append(`First thing.`);
    await policy.append(`Second thing.`);
    const { text } = await policy.get();
    expect(text.match(/## Added from permission cards/gu)).toHaveLength(1);
    expect(text.indexOf(`- First thing.`)).toBeLessThan(text.indexOf(`- Second thing.`));
});

// Placed by section, not simply appended: sections address different subjects (the disposable container vs. the owner's
// own laptop), so a sandbox line landing under "On my devices" would read as a rule about the laptop, not a mistake.
test("a line lands in its own section even when another section was written after it", () => {
    const policy = [`## In this sandbox`, ``, `Ordinary work is fine.`, ``, `## Added from permission cards`, ``, `- First.`, ``, `## On my devices`, ``, `Ask before anything.`, ``].join(`\n`);
    const next = withAddedLine(policy, `Second.`);
    expect(next.indexOf(`- Second.`)).toBeGreaterThan(next.indexOf(`- First.`));
    expect(next.indexOf(`- Second.`)).toBeLessThan(next.indexOf(`## On my devices`));
    // The section it was NOT meant for is untouched.
    expect(next).toContain(`## On my devices\n\nAsk before anything.`);
});

test("the heading and its note are written once, on the first line added", () => {
    const first = withAddedLine(`## In this sandbox\n\nOrdinary work is fine.\n`, `A thing.`);
    expect(first).toContain(`## Added from permission cards`);
    expect(withAddedLine(first, `Another.`).match(/## Added from permission cards/gu)).toHaveLength(1);
});
