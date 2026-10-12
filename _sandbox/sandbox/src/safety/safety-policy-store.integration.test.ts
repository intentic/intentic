import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SAFETY_POLICY } from "@intentic/sandbox-contract";
import { fileSafetyPolicyStore, GRANTED_HEADING, withGrantedLines } from "./safety-policy-store.js";

const store = async (granted: () => Promise<readonly string[]> = async () => []) => {
    const dir = await mkdtemp(join(tmpdir(), "safety-"));
    const path = join(dir, "safety.md");
    return { path, policy: fileSafetyPolicyStore(path, granted) };
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

// Only absence means the shipped default: an owner's policy that is there but cannot be read would otherwise be judged
// by the default's rules.
test("a policy that exists but cannot be read is an error, never the shipped default", async () => {
    const { path, policy } = await store();
    await mkdir(path);
    await expect(policy.get()).rejects.toThrow("EISDIR");
    await expect(policy.text()).rejects.toThrow("EISDIR");
    expect((await stat(path)).isDirectory()).toBe(true);
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

// The card's Always button no longer touches this file: the lines it allowed are owner-wide grants (personas/owner-grants.ts)
// the judge reads after the owner's own text. The Safety page still shows, and saves, only what the owner wrote.
test("the judge reads the owner's text followed by the allowed lines, and the page's reading has none of them", async () => {
    const { path, policy } = await store(async () => [`Deleting build directories under /work is fine.`, `Pushing to a scratch branch is fine.`]);
    await policy.set(`Ask me before anything.`);

    const judged = await policy.text();
    expect(judged).toBe(
        [
            `Ask me before anything.`,
            ``,
            GRANTED_HEADING,
            ``,
            `Lines the owner allowed with Always on a card, oldest first. They hold in every conversation until the owner takes one back under Access.`,
            ``,
            `- Deleting build directories under /work is fine.`,
            `- Pushing to a scratch branch is fine.`,
            ``,
        ].join(`\n`),
    );
    expect(await policy.get()).toEqual({ text: `Ask me before anything.\n`, custom: true });
    expect(await readFile(path, `utf8`)).toBe(`Ask me before anything.\n`);
});

test("with no file the allowed lines follow the shipped default, which the page keeps showing as the default", async () => {
    const { policy } = await store(async () => [`Deleting build directories under /work is fine.`]);
    const judged = await policy.text();
    expect(judged.startsWith(DEFAULT_SAFETY_POLICY.trimEnd())).toBe(true);
    expect(judged).toContain(`- Deleting build directories under /work is fine.`);
    expect(await policy.get()).toEqual({ text: DEFAULT_SAFETY_POLICY, custom: false });
});

test("no allowed line leaves the policy exactly as written, and the same lines always render the same text", () => {
    expect(withGrantedLines(`## In this sandbox\n\nOrdinary work is fine.\n`, [])).toBe(`## In this sandbox\n\nOrdinary work is fine.\n`);
    expect(withGrantedLines(`One line.`, [`A.`, `B.`])).toBe(withGrantedLines(`One line.`, [`A.`, `B.`]));
    // A policy without its final newline still ends its last line before the heading starts.
    expect(withGrantedLines(`One line.`, [`A.`]).startsWith(`One line.\n\n${GRANTED_HEADING}`)).toBe(true);
});

// A grants file this build cannot read is the grants store's to say (personas/owner-grants.ts: it reads as none and warns);
// a reading that fails outright is never turned into a policy with some lines missing.
test("a failed reading of the allowed lines is an error, never a quiet policy without them", async () => {
    const { policy } = await store(async () => {
        throw new Error("disk is gone");
    });
    await expect(policy.text()).rejects.toThrow("disk is gone");
});
