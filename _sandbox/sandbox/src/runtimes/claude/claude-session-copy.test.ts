import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answeredChain, chainBefore, copySession, estimateCopy, parseSession, type SessionLine, writeSessionCopy } from "./claude-session-copy.js";

// Hand-written sessions, so the expected shape is arithmetic: which results survive, which lines go, where parents point.

let uuid = 0;
const line = (entry: Record<string, unknown>): SessionLine => {
    const full = { uuid: `u${(uuid += 1)}`, sessionId: "old", isSidechain: false, ...entry };
    return { raw: JSON.stringify(full), entry: full };
};

const chain = (entries: Record<string, unknown>[]): SessionLine[] => {
    let parent: string | null = null;
    return entries.map((entry) => {
        const made = line({ parentUuid: parent, ...entry });
        parent = made.entry?.uuid ?? null;
        return made;
    });
};

const usage = (context: number): Record<string, number> => ({ input_tokens: 10, cache_read_input_tokens: context - 10, output_tokens: 50 });
const user = (text: string): Record<string, unknown> => ({ type: "user", message: { role: "user", content: text } });
const call = (id: string, command: string, context = 40_000): Record<string, unknown> => ({
    type: "assistant",
    message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }], usage: usage(context) },
});
const result = (id: string, text: string): Record<string, unknown> => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const thinking = (): Record<string, unknown> => ({ type: "assistant", message: { id: "m-think", role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }] } });
const refused = (): Record<string, unknown> => ({
    type: "assistant",
    isApiErrorMessage: true,
    message: { id: "m-err", role: "assistant", content: [{ type: "text", text: "usage limit reached" }] },
});

const parse = (text: string): Record<string, unknown>[] =>
    text
        .trim()
        .split("\n")
        .map((raw) => JSON.parse(raw) as Record<string, unknown>);

const resultsOf = (entries: Record<string, unknown>[]): string[] =>
    entries.flatMap((entry) => {
        const content = (entry["message"] as { content: unknown }).content;
        return Array.isArray(content) ? (content as { type: string; content: string }[]).filter((b) => b.type === "tool_result").map((b) => b.content) : [];
    });

const session = (): SessionLine[] =>
    chain([user("fix the flaky test"), thinking(), call("t1", "pnpm test"), result("t1", "a\nb\nc"), call("t2", "cat x.ts"), result("t2", "x"), call("t3", "git diff", 90_000), result("t3", "diff")]);

describe("copySession", () => {
    it("keeps the newest results whole and stubs the rest with what they were", () => {
        const { text, stats } = copySession(session(), 1, "new");
        expect(stats).toEqual({ cleared: 2, kept: 1, droppedLines: 1 });
        expect(resultsOf(parse(text))).toEqual([
            "[Output cleared at hand-off to save context: Bash pnpm test, was 3 lines. Run it again if you need it.]",
            "[Output cleared at hand-off to save context: Bash cat x.ts, was 1 line. Run it again if you need it.]",
            "diff",
        ]);
    });

    it("drops a thinking-only line and re-parents its child, so the chain a resume walks stays whole", () => {
        const entries = parse(copySession(session(), 10, "new").text);
        const uuids = new Set(entries.map((entry) => entry["uuid"]));
        expect(entries.some((entry) => JSON.stringify(entry).includes('"thinking"'))).toBe(false);
        for (const entry of entries) {
            expect(entry["parentUuid"] === null || uuids.has(entry["parentUuid"])).toBe(true);
            expect(entry["sessionId"]).toBe("new");
        }
        expect(entries[1]?.["parentUuid"]).toBe(entries[0]?.["uuid"]);
    });

    it("with no limit copies every result and only strips thinking", () => {
        const { text, stats } = copySession(session(), Number.POSITIVE_INFINITY, "new");
        expect(stats.cleared).toBe(0);
        expect(resultsOf(parse(text))).toEqual(["a\nb\nc", "x", "diff"]);
    });
});

describe("chainBefore and answeredChain", () => {
    it("follows the last line's ancestry, leaving an abandoned branch out", () => {
        const lines = chain([user("first ask"), call("t1", "ls"), result("t1", "a")]);
        const root = lines[0]?.entry?.uuid;
        const abandoned = line({ parentUuid: root, ...call("t9", "rm -rf build") });
        const retried = line({ parentUuid: root, ...call("t2", "ls -la") });
        const all = [...lines, abandoned, retried];
        expect(chainBefore(all, all.length).map((l) => l.entry?.uuid)).toEqual([root, retried.entry?.uuid]);
    });

    it("drops the refused request's error reply and the message nothing answered, keeping tool results", () => {
        const lines = chain([user("go"), call("t1", "ls"), result("t1", "a"), user("now ship it"), refused()]);
        const kept = answeredChain(chainBefore(lines, lines.length), true);
        expect(kept.map((l) => l.entry?.type)).toEqual(["user", "assistant", "user"]);
        expect(JSON.stringify(kept.at(-1)?.entry)).toContain("tool_result");
        expect(answeredChain(chainBefore(lines, lines.length), false).map((l) => l.entry?.type)).toEqual(["user", "assistant", "user", "user"]);
    });
});

describe("estimateCopy", () => {
    it("scales the session's own measured context by the share of characters trimming keeps", () => {
        const big = "line\n".repeat(20_000);
        const lines = chain([user("go"), call("t1", "cat big.log", 20_000), result("t1", big), call("t2", "ls", 60_000), result("t2", "a")]);
        const estimate = estimateCopy(lines, undefined);
        expect(estimate?.carryTokens).toBe(60_000);
        expect(estimate?.cleared).toBe(0);
        // Keep-10 clears nothing here; a session with more results than that is cut down to a fraction.
        const many = chain([
            user("go"),
            ...Array.from({ length: 12 }, (_, index) => [call(`c${index}`, `cat ${index}.log`, 20_000 + index * 10_000), result(`c${index}`, big)]).flat(),
        ]);
        const trimmed = estimateCopy(many, undefined);
        expect(trimmed?.cleared).toBe(2);
        expect(trimmed?.trimTokens).toBeLessThan(trimmed?.carryTokens ?? 0);
        expect(trimmed?.trimTokens).toBeGreaterThan(trimmed?.overhead ?? 0);
    });
});

describe("writeSessionCopy", () => {
    it("writes the trimmed copy beside the original under a new id and leaves the original alone", async () => {
        const store = await mkdtemp(join(tmpdir(), "session-copy-"));
        try {
            const dir = join(store, "projects", "-work-repo");
            await mkdir(dir, { recursive: true });
            const lines = chain([
                user("go"),
                ...Array.from({ length: 12 }, (_, index) => [call(`c${index}`, `cat ${index}`), result(`c${index}`, `out ${index}`)]).flat(),
                user("and the docs"),
                refused(),
            ]);
            const original = `${lines.map((l) => l.raw).join("\n")}\n`;
            await writeFile(join(dir, "s-1.jsonl"), original);
            const copy = await writeSessionCopy(store, "s-1", { keep: 10, dropUnanswered: true });
            expect(copy?.cleared).toBe(2);
            const written = parseSession(await readFile(join(dir, `${copy?.sessionId}.jsonl`), "utf8"));
            expect(written.every((l) => l.entry?.sessionId === copy?.sessionId)).toBe(true);
            expect(written.some((l) => JSON.stringify(l.entry).includes("and the docs"))).toBe(false);
            expect(await readFile(join(dir, "s-1.jsonl"), "utf8")).toBe(original);
            expect(await writeSessionCopy(store, "../escape", { keep: 10, dropUnanswered: true })).toBeUndefined();
            expect(await writeSessionCopy(store, "missing", { keep: 10, dropUnanswered: true })).toBeUndefined();
        } finally {
            await rm(store, { recursive: true, force: true });
        }
    });
});
