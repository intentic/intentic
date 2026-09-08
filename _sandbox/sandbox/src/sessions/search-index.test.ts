import { expect, test } from "vitest";
import { IN_MEMORY, openSearchIndex } from "./search-index.js";
import type { SpokenLine } from "./transcript-search.js";

const said = (...lines: [string, "user" | "agent"][]): SpokenLine[] => lines.map(([text, speaker]) => ({ text, speaker }));

const fresh = () => openSearchIndex(IN_MEMORY);

test("finds a source by a phrase either side said, and reports whose words matched", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["fix the login redirect", "user"], ["landAgent lives in laneDrop.ts", "agent"]));
    index.put("c2", "conversation", "1", said(["tidy the changelog", "user"]));

    expect(index.search("login", "conversation", false).get("c1")).toEqual({ text: "fix the login redirect", speaker: "user" });
    expect(index.search("laneDrop", "conversation", false).get("c1")).toEqual({ text: "landAgent lives in laneDrop.ts", speaker: "agent" });
    expect([...index.search("changelog", "conversation", false).keys()]).toEqual(["c2"]);
    expect(index.search("nothing here", "conversation", false).size).toBe(0);
});

// The index tokenizes trigrams, not words, so a query matches as a phrase, not as separate words.
test("matches a mid-word fragment and a multi-word phrase alike", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["explain the fleet board filter", "user"]));

    expect(index.search("eet boa", "conversation", false).has("c1")).toBe(true);
    expect(index.search("the fleet board", "conversation", false).has("c1")).toBe(true);
    expect(index.search("fleet filter", "conversation", false).has("c1")).toBe(false);
});

test("prefers the oldest user line, falling back to the agent's", () => {
    const index = fresh();
    index.put(
        "c1",
        "conversation",
        "1",
        said(["the agent said worktree first", "agent"], ["my own worktree question", "user"], ["a later worktree question", "user"]),
    );
    expect(index.search("worktree", "conversation", false).get("c1")).toEqual({ text: "my own worktree question", speaker: "user" });

    index.put("c2", "conversation", "1", said(["only the agent mentions worktree", "agent"]));
    expect(index.search("worktree", "conversation", false).get("c2")).toEqual({ text: "only the agent mentions worktree", speaker: "agent" });
});

// sqlite's own case-folding is ASCII-only; the index stores a JS-folded column and folds the needle the same way so
// non-ASCII case-insensitive matches work.
test("case-insensitive matching covers non-ASCII, and the Aa switch is exact", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["Ärger im Büro", "user"], ["ÉCOLE normale", "user"]));

    expect(index.search("ärger", "conversation", false).has("c1")).toBe(true);
    expect(index.search("ÄRGER", "conversation", false).has("c1")).toBe(true);
    expect(index.search("école", "conversation", false).has("c1")).toBe(true);

    expect(index.search("Ärger", "conversation", true).has("c1")).toBe(true);
    expect(index.search("ärger", "conversation", true).size).toBe(0);
});

test("case-sensitive search still finds a hit that only a later line spells correctly", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["landagent in lower case", "user"], ["landAgent as written", "user"]));
    expect(index.search("landAgent", "conversation", true).get("c1")).toEqual({ text: "landAgent as written", speaker: "user" });
});

// SQL LIKE's own wildcards (%, _) must be escaped, or a query containing one would silently match everything.
test("wildcards a user types are literal, not patterns", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["we hit 100% of it", "user"]));
    index.put("c2", "conversation", "1", said(["nothing special here", "user"]));

    expect([...index.search("100%", "conversation", false).keys()]).toEqual(["c1"]);
    expect(index.search("%", "conversation", false).size).toBe(1);
    expect(index.search("_", "conversation", false).size).toBe(0);
});

test("a long line comes back windowed around the hit, not cut from the start", () => {
    const index = fresh();
    const line = `${"filler ".repeat(40)}the needle${" trailing".repeat(40)}`;
    index.put("c1", "conversation", "1", said([line, "user"]));
    const snippet = index.search("the needle", "conversation", false).get("c1")?.text ?? "";

    expect(snippet).toContain("the needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(122);
});

test("kinds are separate: a conversation's words never answer a session query", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["shared phrase", "user"]));
    index.put("s1", "session", "1", said(["shared phrase", "user"]));

    expect([...index.search("shared phrase", "conversation", false).keys()]).toEqual(["c1"]);
    expect([...index.search("shared phrase", "session", false).keys()]).toEqual(["s1"]);
});

// `extend` appends (the settle path); `put` re-states a source whole (the backfill's), which is what lets a rewind's
// shrink actually take effect.
test("a settled turn extends a source; a rewind's re-statement drops what went", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["first turn", "user"]));
    index.extend("c1", "conversation", "2", said(["second turn", "user"]));

    expect(index.search("first turn", "conversation", false).has("c1")).toBe(true);
    expect(index.search("second turn", "conversation", false).has("c1")).toBe(true);
    expect(index.versions("conversation").get("c1")).toBe("2");

    index.put("c1", "conversation", "3", said(["first turn", "user"]));
    expect(index.search("second turn", "conversation", false).has("c1")).toBe(false);
    expect(index.search("first turn", "conversation", false).has("c1")).toBe(true);
});

test("forget takes a source out entirely", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["purge me", "user"]));
    index.forget("c1");

    expect(index.search("purge me", "conversation", false).size).toBe(0);
    expect(index.versions("conversation").has("c1")).toBe(false);
});

// Backfill uses this to ask "still current" with one stat, not a read.
test("versions report what each source was last indexed at", () => {
    const index = fresh();
    index.put("c1", "conversation", "512", said(["a", "user"]));
    index.put("s1", "session", "99", said(["b", "user"]));

    expect(index.versions("conversation")).toEqual(new Map([["c1", "512"]]));
    expect(index.versions("session")).toEqual(new Map([["s1", "99"]]));
});

test("metrics count sources per kind and lines overall", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["one", "user"], ["two", "agent"]));
    index.put("s1", "session", "1", said(["three", "user"]));

    expect(index.metrics()).toEqual({ conversations: 1, sessions: 1, lines: 3 });
});

// Below three characters the trigram index can't narrow; two is the floor, and short queries like "ci" or "db" are real
// searches.
test("a two-character query is still answered correctly", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["check the ci run", "user"]));
    index.put("c2", "conversation", "1", said(["nothing matching", "user"]));

    expect([...index.search("ci", "conversation", false).keys()]).toEqual(["c1"]);
});
