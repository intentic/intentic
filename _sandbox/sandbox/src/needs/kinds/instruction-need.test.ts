import { MEMORY_MAX_CHARS } from "@intentic/constants";
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { appendDiff, instructionFile, instructionNeed, withRule } from "./instruction-need.js";

// A standing rule the owner said once, kept in an AGENTS.md only by a person's approval: the card carries the exact
// change, the yes appends it on the main tree and commits it, and words the file already holds meet the ask without a
// card. The files here are a map standing in for the main tree (needs-slice.ts mainTreeFiles reads and writes the real
// one); `dirty` names files holding the owner's own uncommitted edits, which the write leaves uncommitted.

const harness = (files: Record<string, string> = {}, folders: readonly string[] = [".", "game"], dirty: readonly string[] = []) => {
    const tree = new Map(Object.entries(files));
    const writes: string[] = [];
    const commits: string[] = [];
    const kind = instructionNeed({
        read: async (file) => tree.get(file),
        write: async (file, text, subject) => {
            writes.push(file);
            tree.set(file, text);
            if (dirty.includes(file)) {
                return false;
            }
            commits.push(subject);
            return true;
        },
        folder: async (file) => folders.includes(file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "."),
    });
    return { kind, tree, writes, commits };
};

const needOf = (subject: Need["subject"]): Need => ({ id: "need-1", conversationId: "conv-1", subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });
const context = { conversationId: "conv-1", standing: undefined };
const RULES = "# House rules\n\n- Port Bevy's algorithm when ours loses.\n";

describe("instruction need", () => {
    it("raises a card carrying the exact change to the workspace's AGENTS.md, and writes nothing", async () => {
        const { kind, writes } = harness({ "AGENTS.md": RULES });
        expect(await kind.resolve({ kind: "instruction", file: "AGENTS.md", text: "- Don't overdo tests." }, context)).toEqual({
            kind: "raise",
            title: "Remember in AGENTS.md: Don't overdo tests.",
            subject: {
                kind: "instruction",
                file: "AGENTS.md",
                text: "- Don't overdo tests.",
                diff: [
                    "--- a/AGENTS.md",
                    "+++ b/AGENTS.md",
                    "@@ -1,3 +1,4 @@",
                    " # House rules",
                    " ",
                    " - Port Bevy's algorithm when ours loses.",
                    "+- Don't overdo tests.",
                ].join("\n"),
            },
        });
        expect(writes).toEqual([]);
    });

    it("appends the rule on approval, exactly as the diff showed it, commits it on its own, and meets the need", async () => {
        const { kind, tree, commits } = harness({ "AGENTS.md": RULES });
        const raised = await kind.resolve({ kind: "instruction", file: "AGENTS.md", text: "- Don't overdo tests." }, context);
        if (raised.kind !== "raise") {
            throw new Error(`expected a card, got ${raised.kind}`);
        }
        const answered = await kind.answer(needOf(raised.subject), { kind: "approve" }, { email: "owner@acme.dev" });
        expect(answered).toMatchObject({ status: "met", result: "The rule is in AGENTS.md now, committed on its own on the main line." });
        expect(tree.get("AGENTS.md")).toBe(`${RULES}- Don't overdo tests.\n`);
        expect(commits).toEqual(["Instructions: remember in AGENTS.md: Don't overdo tests."]);
        // Approving twice (a second tab) writes nothing more.
        expect(await kind.answer(needOf(raised.subject), { kind: "approve" }, { email: "owner@acme.dev" })).toMatchObject({
            status: "met",
            result: "AGENTS.md already holds this rule.",
        });
        expect(tree.get("AGENTS.md")).toBe(`${RULES}- Don't overdo tests.\n`);
        expect(commits).toHaveLength(1);
    });

    it("leaves the rule uncommitted, and says so, when the file already held the owner's own unsaved edits", async () => {
        const { kind, tree, commits } = harness({ "AGENTS.md": RULES }, [".", "game"], ["AGENTS.md"]);
        const raised = await kind.resolve({ kind: "instruction", file: "AGENTS.md", text: "- Keep commits small." }, context);
        if (raised.kind !== "raise") {
            throw new Error(`expected a card, got ${raised.kind}`);
        }
        const answered = await kind.answer(needOf(raised.subject), { kind: "approve" }, { email: "owner@acme.dev" });
        expect(answered).toMatchObject({ status: "met", result: expect.stringContaining("uncommitted: the file held their own unsaved edits") });
        expect(tree.get("AGENTS.md")).toBe(`${RULES}- Keep commits small.\n`);
        expect(commits).toEqual([]);
    });

    it("creates a repository's AGENTS.md when it has none, from a folder named on its own", async () => {
        const { kind, tree } = harness();
        const raised = await kind.resolve({ kind: "instruction", file: "game/", text: "Beat Bevy on every case." }, context);
        expect(raised).toEqual({
            kind: "raise",
            title: "Remember in game/AGENTS.md: Beat Bevy on every case.",
            subject: {
                kind: "instruction",
                file: "game/AGENTS.md",
                text: "Beat Bevy on every case.",
                diff: "--- /dev/null\n+++ b/game/AGENTS.md\n@@ -0,0 +1,1 @@\n+Beat Bevy on every case.",
                creates: true,
            },
        });
        if (raised.kind === "raise") {
            await kind.answer(needOf(raised.subject), { kind: "approve" }, { email: "owner@acme.dev" });
        }
        expect(tree.get("game/AGENTS.md")).toBe("Beat Bevy on every case.\n");
    });

    it("answers met without a card when the file already says it, and meets an open card once someone writes it by hand", async () => {
        const { kind, tree } = harness({ "AGENTS.md": RULES });
        expect(await kind.resolve({ kind: "instruction", file: "AGENTS.md", text: "- Port Bevy's   algorithm when ours loses." }, context)).toEqual({
            kind: "met",
            message: "AGENTS.md already holds this rule.",
        });
        const need = needOf({ kind: "instruction", file: "AGENTS.md", text: "- Keep commits small.", diff: "" });
        expect(await kind.check(need)).toBeUndefined();
        tree.set("AGENTS.md", `${RULES}- Keep commits small.\n`);
        expect(await kind.check(need)).toMatchObject({ result: "AGENTS.md already holds this rule." });
    });

    it("refuses a file outside the workspace, a folder that is not there, and any other answer than approve", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "instruction", file: "../other/AGENTS.md", text: "x" }, context)).toEqual({
            kind: "refused",
            code: "invalid_file",
            message: "Nothing was proposed: ../other/AGENTS.md is outside the workspace.",
        });
        expect(await kind.resolve({ kind: "instruction", file: "/work/AGENTS.md", text: "x" }, context)).toMatchObject({ kind: "refused", code: "invalid_file" });
        expect(await kind.resolve({ kind: "instruction", file: "engine/AGENTS.md", text: "x" }, context)).toEqual({
            kind: "refused",
            code: "invalid_file",
            message: "Nothing was proposed: there is no folder engine in the workspace.",
        });
        const need = needOf({ kind: "instruction", file: "AGENTS.md", text: "x", diff: "" });
        expect(await kind.answer(need, { kind: "accept" }, { email: "owner@acme.dev" })).toEqual({ refused: "A rule is answered by approving it, or declined." });
    });

    it("keys a proposal by its file and its words, so asking again finds the first card", () => {
        const { kind } = harness();
        const key = (text: string) => kind.key({ kind: "instruction", file: "AGENTS.md", text, diff: "" });
        expect(key("- Keep  commits small.")).toBe(key("- Keep commits small."));
        expect(key("- Keep commits small.")).not.toBe(key("- Keep commits tiny."));
    });
});

describe("the rule's place in the file", () => {
    it("names an AGENTS.md from a file, a folder or nothing, and nothing outside the root", () => {
        expect(instructionFile("")).toEqual({ file: "AGENTS.md" });
        expect(instructionFile("./AGENTS.md")).toEqual({ file: "AGENTS.md" });
        expect(instructionFile("game")).toEqual({ file: "game/AGENTS.md" });
        expect(instructionFile("game/../AGENTS.md")).toEqual({ file: "AGENTS.md" });
        expect(instructionFile("game/../../AGENTS.md")).toEqual({ problem: "game/../../AGENTS.md is outside the workspace" });
    });

    it("joins a bullet to a list it ends, and sets anything else apart as a paragraph", () => {
        expect(withRule("- one\n- two\n\n\n", "- three")).toBe("- one\n- two\n- three\n");
        expect(withRule("Some prose.", "- three")).toBe("Some prose.\n\n- three\n");
        expect(withRule("- one", "Prose rule.")).toBe("- one\n\nProse rule.\n");
        expect(withRule(undefined, "  First rule.  ")).toBe("First rule.\n");
    });

    it("shows trailing blank lines the append drops as removed", () => {
        expect(appendDiff("AGENTS.md", "a\n\n\n", "a\n\nb\n")).toBe("--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,3 +1,3 @@\n a\n \n-\n+b");
    });
});

// A file a turn would drop whole for length (agent/prompt/workspace-memory.ts) takes every rule in it out of every turn
// below it, so a rule that would push it there is never proposed, and never written by a stale card.
describe("the ceiling every turn's rules share", () => {
    const rule = "- Keep commits small.";

    it("refuses a rule that would push its file past what the files above it leave", async () => {
        const { kind } = harness({ "AGENTS.md": "x".repeat(MEMORY_MAX_CHARS - 100), "game/AGENTS.md": "y".repeat(90) });
        const resolved = await kind.resolve({ kind: "instruction", file: "game/AGENTS.md", text: rule }, context);
        expect(resolved).toMatchObject({ kind: "refused", code: "too_long" });
        expect(resolved.kind === "refused" ? resolved.message : "").toContain(`game/AGENTS.md would be ${(90 + 2 + rule.length).toLocaleString("en")} characters`);
    });

    it("raises the same rule while it fits", async () => {
        const { kind } = harness({ "AGENTS.md": "x".repeat(MEMORY_MAX_CHARS - 200), "game/AGENTS.md": "y".repeat(90) });
        expect(await kind.resolve({ kind: "instruction", file: "game/AGENTS.md", text: rule }, context)).toMatchObject({ kind: "raise" });
    });

    it("does not write an approved card once other rules have used up the room it had", async () => {
        const { kind, tree, writes } = harness({ "AGENTS.md": RULES });
        const raised = await kind.resolve({ kind: "instruction", file: "AGENTS.md", text: rule }, context);
        if (raised.kind !== "raise") {
            throw new Error(`expected a card, got ${raised.kind}`);
        }
        tree.set("AGENTS.md", "x".repeat(MEMORY_MAX_CHARS - 5));
        expect(await kind.answer(needOf(raised.subject), { kind: "approve" }, { email: "owner@acme.dev" })).toMatchObject({
            refused: expect.stringContaining("The owner has to shorten AGENTS.md first"),
        });
        expect(writes).toEqual([]);
    });
});
