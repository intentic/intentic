import { carrySession, chainBefore, type SessionLine, seedPrompt, trimSession } from "./handoff-arms.js";

// Hand-written sessions so the expected shape is arithmetic: which results survive, which lines go, where parents point.

let uuid = 0;
const line = (entry: Record<string, unknown>): SessionLine => {
    const full = { uuid: `u${(uuid += 1)}`, sessionId: "old", isSidechain: false, ...entry };
    return { raw: JSON.stringify(full), entry: full };
};

const chain = (entries: Record<string, unknown>[]): SessionLine[] => {
    let parent: string | null = null;
    return entries.map((entry) => {
        const made = line({ parentUuid: parent, ...entry });
        parent = made.entry!.uuid!;
        return made;
    });
};

const user = (text: string): Record<string, unknown> => ({ type: "user", message: { role: "user", content: text } });
const call = (id: string, command: string): Record<string, unknown> => ({
    type: "assistant",
    message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
});
const result = (id: string, text: string): Record<string, unknown> => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const thinking = (): Record<string, unknown> => ({ type: "assistant", message: { id: "m-think", role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }] } });

const parse = (text: string): Record<string, unknown>[] =>
    text
        .trim()
        .split("\n")
        .map((raw) => JSON.parse(raw) as Record<string, unknown>);

const session = (): SessionLine[] =>
    chain([user("fix the flaky test"), thinking(), call("t1", "pnpm test"), result("t1", "a\nb\nc"), call("t2", "cat x.ts"), result("t2", "x"), call("t3", "git diff"), result("t3", "diff"), user("now ship it")]);

describe("trimSession", () => {
    it("keeps the newest results whole and stubs the rest with what they were", () => {
        const lines = session();
        const { text, stats } = trimSession(lines, 8, 1, "new");
        const entries = parse(text);
        const results = entries.flatMap((entry) => ((entry["message"] as { content: unknown }).content as { type: string; content: string }[]).filter?.((b) => b.type === "tool_result") ?? []);
        expect(stats).toEqual({ cleared: 2, kept: 1, droppedLines: 1 });
        expect(results.map((b) => b.content)).toEqual([
            "[Output cleared at hand-off to save context: Bash pnpm test, was 3 lines. Run it again if you need it.]",
            "[Output cleared at hand-off to save context: Bash cat x.ts, was 1 line. Run it again if you need it.]",
            "diff",
        ]);
    });

    it("drops a thinking-only line and re-parents its child so the chain stays whole", () => {
        const lines = session();
        const entries = parse(trimSession(lines, 8, 10, "new").text);
        const uuids = new Set(entries.map((entry) => entry["uuid"]));
        expect(entries.some((entry) => JSON.stringify(entry).includes('"thinking"'))).toBe(false);
        for (const entry of entries) {
            expect(entry["parentUuid"] === null || uuids.has(entry["parentUuid"])).toBe(true);
            expect(entry["sessionId"]).toBe("new");
        }
        expect(entries[1]!["parentUuid"]).toBe(entries[0]!["uuid"]);
    });

    it("stops at the cut: the next message is not part of the hand-off", () => {
        expect(parse(trimSession(session(), 8, 10, "new").text).some((entry) => JSON.stringify(entry).includes("now ship it"))).toBe(false);
    });
});

describe("chainBefore", () => {
    it("follows the next line's parent, leaving an abandoned branch out", () => {
        const lines = chain([user("first ask"), call("t1", "ls"), result("t1", "a")]);
        const root = lines[0]!.entry!.uuid!;
        const abandoned = line({ parentUuid: root, ...call("t9", "rm -rf build") });
        const retried = line({ parentUuid: root, ...call("t2", "ls -la") });
        const next = line({ parentUuid: retried.entry!.uuid, ...user("go on") });
        const all = [...lines, abandoned, retried, next];
        expect(chainBefore(all, all.length - 1).map((l) => l.entry?.uuid)).toEqual([root, retried.entry?.uuid]);
    });
});

describe("carrySession", () => {
    it("is the prefix verbatim but for the session id", () => {
        const lines = session();
        const entries = parse(carrySession(lines, 8, "new"));
        expect(entries).toHaveLength(8);
        const original: unknown[] = lines.slice(0, 8).map((l) => l.entry);
        expect(entries.map((entry): unknown => ({ ...entry, sessionId: "old" }))).toEqual(original);
    });
});

describe("seedPrompt", () => {
    it("carries the user's words and the tools used, not their output", () => {
        const prompt = seedPrompt(session(), 8, "now ship it");
        expect(prompt).toContain("fix the flaky test");
        expect(prompt).toContain("Bash pnpm test");
        expect(prompt).not.toContain("a\nb\nc");
        expect(prompt.endsWith("now ship it")).toBe(true);
    });
});
