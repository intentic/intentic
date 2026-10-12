import { IN_MEMORY } from "@intentic/base/sqlite";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { openSearchIndex } from "./search-index.js";
import { type SpokenLine, spokenLinesOf } from "./transcript-search.js";

const said = (...lines: [string, "user" | "agent"][]): SpokenLine[] => lines.map(([text, speaker]) => ({ text, speaker }));

const fresh = () => openSearchIndex(IN_MEMORY);

test("finds a source by a phrase either side said, and reports whose words matched", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["fix the login redirect", "user"], ["landAgent lives in laneDrop.ts", "agent"]));
    await index.put("c2", "conversation", "1", said(["tidy the changelog", "user"]));

    expect((await index.search("login", "conversation", false)).get("c1")).toEqual({ text: "fix the login redirect", speaker: "user" });
    expect((await index.search("laneDrop", "conversation", false)).get("c1")).toEqual({ text: "landAgent lives in laneDrop.ts", speaker: "agent" });
    expect([...(await index.search("changelog", "conversation", false)).keys()]).toEqual(["c2"]);
    expect((await index.search("nothing here", "conversation", false)).size).toBe(0);
});

// The index tokenizes trigrams, not words, so a query matches as a phrase, not as separate words.
test("matches a mid-word fragment and a multi-word phrase alike", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["explain the fleet board filter", "user"]));

    expect((await index.search("eet boa", "conversation", false)).has("c1")).toBe(true);
    expect((await index.search("the fleet board", "conversation", false)).has("c1")).toBe(true);
    expect((await index.search("fleet filter", "conversation", false)).has("c1")).toBe(false);
});

test("prefers the oldest user line, falling back to the agent's", async () => {
    const index = fresh();
    await index.put(
        "c1",
        "conversation",
        "1",
        said(["the agent said worktree first", "agent"], ["my own worktree question", "user"], ["a later worktree question", "user"]),
    );
    expect((await index.search("worktree", "conversation", false)).get("c1")).toEqual({ text: "my own worktree question", speaker: "user" });

    await index.put("c2", "conversation", "1", said(["only the agent mentions worktree", "agent"]));
    expect((await index.search("worktree", "conversation", false)).get("c2")).toEqual({ text: "only the agent mentions worktree", speaker: "agent" });
});

// sqlite's own case-folding is ASCII-only; the index stores a JS-folded column and folds the needle the same way so
// non-ASCII case-insensitive matches work.
test("case-insensitive matching covers non-ASCII, and the Aa switch is exact", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["Ärger im Büro", "user"], ["ÉCOLE normale", "user"]));

    expect((await index.search("ärger", "conversation", false)).has("c1")).toBe(true);
    expect((await index.search("ÄRGER", "conversation", false)).has("c1")).toBe(true);
    expect((await index.search("école", "conversation", false)).has("c1")).toBe(true);

    expect((await index.search("Ärger", "conversation", true)).has("c1")).toBe(true);
    expect((await index.search("ärger", "conversation", true)).size).toBe(0);
});

test("case-sensitive search still finds a hit that only a later line spells correctly", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["landagent in lower case", "user"], ["landAgent as written", "user"]));
    expect((await index.search("landAgent", "conversation", true)).get("c1")).toEqual({ text: "landAgent as written", speaker: "user" });
});

// SQL LIKE's own wildcards (%, _) must be escaped, or a query containing one would silently match everything.
test("wildcards a user types are literal, not patterns", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["we hit 100% of it", "user"]));
    await index.put("c2", "conversation", "1", said(["nothing special here", "user"]));

    expect([...(await index.search("100%", "conversation", false)).keys()]).toEqual(["c1"]);
    expect((await index.search("%", "conversation", false)).size).toBe(1);
    expect((await index.search("_", "conversation", false)).size).toBe(0);
});

// Trigrams alone admit both lines; only the literal re-check tells `_` from the character it stands in for.
test("a typed underscore stays literal where the trigram index admits a near-miss", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["rename snake_case keys", "user"]));
    await index.put("c2", "conversation", "1", said(["rename snakeXcase keys", "user"]));

    expect([...(await index.search("snake_case", "conversation", false)).keys()]).toEqual(["c1"]);
    expect([...(await index.search("snake_case", "conversation", true)).keys()]).toEqual(["c1"]);
});

test("a long line comes back windowed around the hit, not cut from the start", async () => {
    const index = fresh();
    const line = `${"filler ".repeat(40)}the needle${" trailing".repeat(40)}`;
    await index.put("c1", "conversation", "1", said([line, "user"]));
    const snippet = (await index.search("the needle", "conversation", false)).get("c1")?.text ?? "";

    expect(snippet).toContain("the needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(122);
});

test("kinds are separate: a conversation's words never answer a session query", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["shared phrase", "user"]));
    await index.put("s1", "session", "1", said(["shared phrase", "user"]));

    expect([...(await index.search("shared phrase", "conversation", false)).keys()]).toEqual(["c1"]);
    expect([...(await index.search("shared phrase", "session", false)).keys()]).toEqual(["s1"]);
});

// `extend` appends (the settle path); `put` re-states a source whole (the backfill's), which is what lets a rewind's
// shrink actually take effect.
test("a settled turn extends a source; a rewind's re-statement drops what went", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["first turn", "user"]));
    await index.extend("c1", "conversation", "2", said(["second turn", "user"]));

    expect((await index.search("first turn", "conversation", false)).has("c1")).toBe(true);
    expect((await index.search("second turn", "conversation", false)).has("c1")).toBe(true);
    expect((await index.versions("conversation")).get("c1")).toBe("2");

    await index.put("c1", "conversation", "3", said(["first turn", "user"]));
    expect((await index.search("second turn", "conversation", false)).has("c1")).toBe(false);
    expect((await index.search("first turn", "conversation", false)).has("c1")).toBe(true);
});

test("forget takes a source out entirely", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["purge me", "user"]));
    await index.forget("c1");

    expect((await index.search("purge me", "conversation", false)).size).toBe(0);
    expect((await index.versions("conversation")).has("c1")).toBe(false);
});

// Backfill uses this to ask "still current" with one stat, not a read.
test("versions report what each source was last indexed at", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "512", said(["a", "user"]));
    await index.put("s1", "session", "99", said(["b", "user"]));

    expect(await index.versions("conversation")).toEqual(new Map([["c1", "512"]]));
    expect(await index.versions("session")).toEqual(new Map([["s1", "99"]]));
});

test("metrics count sources per kind and lines overall", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["one", "user"], ["two", "agent"]));
    await index.put("s1", "session", "1", said(["three", "user"]));

    expect(index.metrics()).toEqual({ conversations: 1, sessions: 1, lines: 3 });
});

// Below three characters the trigram index can't narrow; two is the floor, and short queries like "ci" or "db" are real
// searches.
test("a two-character query is still answered correctly", async () => {
    const index = fresh();
    await index.put("c1", "conversation", "1", said(["check the ci run", "user"]));
    await index.put("c2", "conversation", "1", said(["nothing matching", "user"]));

    expect([...(await index.search("ci", "conversation", false)).keys()]).toEqual(["c1"]);
});

// The worker answers a read between a long put's batches, so a keystroke's search is not held behind a whole backfill
// write; the put itself still lands every line.
test("a search sent during a long put answers before the put finishes", async () => {
    const index = fresh();
    await index.put("c0", "conversation", "1", said(["already here", "user"]));
    const order: string[] = [];
    const lines = Array.from({ length: 5_000 }, (_, i): [string, "user"] => [`bulk line ${String(i)}`, "user"]);
    const writing = index.put("c1", "conversation", "1", said(...lines)).then(() => void order.push("put"));
    const reading = index.search("already here", "conversation", false).then((found) => {
        order.push("search");
        return found;
    });

    expect((await reading).has("c0")).toBe(true);
    await writing;
    expect(order).toEqual(["search", "put"]);
    expect((await index.search("bulk line 4999", "conversation", false)).has("c1")).toBe(true);
    expect(index.metrics()).toEqual({ conversations: 2, sessions: 0, lines: 5_001 });
});

// A record yields what the conversation did beside what it said; only a search that asks for deeds sees them, so the
// board's filter and the history box still match speech alone.
test("deeds are found only when asked for, each saying what kind of line it was", async () => {
    const index = fresh();
    const rows: TranscriptRow[] = [
        { role: "user", text: "why does the daemon die", run: "run-1" },
        {
            role: "assistant",
            text: "Looking at the socket.",
            run: "run-1",
            tools: [
                { id: "t1", name: "Bash", category: "execute", status: "completed", target: "curl --unix-socket /run/intentic/front.sock http://x/" },
                { id: "t2", name: "mcp__omen__manage_sandbox", category: "other", status: "completed" },
                {
                    id: "t3",
                    name: "Agent",
                    category: "other",
                    status: "completed",
                    subagent: { kind: "subagent", status: "completed", description: "Map the land queue" },
                    children: [{ id: "t4", name: "Read", category: "read", status: "completed", target: "/work/queue-run.ts" }],
                },
            ],
            question: {
                requestId: "q1",
                status: "answered",
                questions: [{ question: "Restart the daemon now?", header: "Restart", multiSelect: false, options: [] }],
                answers: { "Restart the daemon now?": ["Later"] },
            },
        },
        { role: "notice", text: "The sandbox came back, this turn picked up where it left off.", run: "run-1" },
    ];
    await index.put("c1", "conversation", "1", spokenLinesOf(rows));

    expect((await index.search("front.sock", "conversation", false)).size).toBe(0);
    const found = async (needle: string) => (await index.search(needle, "conversation", false, true)).get("c1");
    expect(await found("front.sock")).toEqual({ text: "Bash curl --unix-socket /run/intentic/front.sock http://x/", speaker: "agent", via: "ran" });
    expect(await found("manage_sandbox")).toMatchObject({ via: "ran" });
    expect(await found("land queue")).toMatchObject({ text: "Agent Map the land queue", via: "ran" });
    expect(await found("queue-run.ts")).toMatchObject({ via: "ran" });
    expect(await found("restart the daemon")).toEqual({ text: "Restart the daemon now? → Later", speaker: "agent", via: "asked" });
    expect(await found("picked up where")).toMatchObject({ via: "notice" });
    expect(await found("run-1")).toEqual({ text: "run run-1", speaker: "agent", via: "run" });
    // What was said still wins over what was done when both match.
    expect(await found("socket")).toEqual({ text: "Looking at the socket.", speaker: "agent" });
});

// A command is found by its opening; a heredoc kept whole would make deeds several times the size of everything said.
test("a deed's line is cut to its opening and kept once however often it was done", () => {
    const tool = { id: "t", name: "Bash", category: "execute" as const, status: "completed" as const, target: `cat <<'EOF'\n${"x".repeat(400)}\nEOF` };
    const lines = spokenLinesOf([{ role: "assistant", text: "", tools: [tool, { ...tool, id: "t2" }] }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text.length).toBe(160);
    expect(lines[0]?.text.startsWith("Bash cat <<'EOF' xxx")).toBe(true);
});
