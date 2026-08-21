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

// A phrase is a phrase, not its words: this is the whole reason the index tokenizes trigrams rather than words.
test("matches a mid-word fragment and a multi-word phrase alike", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["explain the fleet board filter", "user"]));

    expect(index.search("eet boa", "conversation", false).has("c1")).toBe(true);
    expect(index.search("the fleet board", "conversation", false).has("c1")).toBe(true);
    // Words that are all present but not adjacent are NOT a phrase match.
    expect(index.search("fleet filter", "conversation", false).has("c1")).toBe(false);
});

/* THE USER'S OWN WORDS WIN, and among theirs the OLDEST. A query is typed from memory, and what a person
 * remembers is their own phrasing; the agent repeating the term back later is the weaker evidence even though
 * it may sit earlier in the transcript. */
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

/* CASE FOLDING IS JS'S, NOT SQLITE'S, and this is the test that pins it. sqlite's own case-insensitivity is
 * ASCII-only: with the text stored as written, a search for "ärger" does not find "Ärger", which the in-memory
 * scan this replaced did find. The index therefore stores a JS-folded column and folds the needle the same way. */
test("case-insensitive matching covers non-ASCII, and the Aa switch is exact", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["Ärger im Büro", "user"], ["ÉCOLE normale", "user"]));

    expect(index.search("ärger", "conversation", false).has("c1")).toBe(true);
    expect(index.search("ÄRGER", "conversation", false).has("c1")).toBe(true);
    expect(index.search("école", "conversation", false).has("c1")).toBe(true);

    // Case-sensitive: only the spelling as written.
    expect(index.search("Ärger", "conversation", true).has("c1")).toBe(true);
    expect(index.search("ärger", "conversation", true).size).toBe(0);
});

test("case-sensitive search still finds a hit that only a later line spells correctly", () => {
    const index = fresh();
    // The folded LIKE matches both lines; only the second survives the exact confirmation.
    index.put("c1", "conversation", "1", said(["landagent in lower case", "user"], ["landAgent as written", "user"]));
    expect(index.search("landAgent", "conversation", true).get("c1")).toEqual({ text: "landAgent as written", speaker: "user" });
});

// LIKE's own wildcards have to be literals here, or a query containing one silently matches everything.
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
    // Bounded by SNIPPET_CHARS plus the two ellipses.
    expect(snippet.length).toBeLessThanOrEqual(122);
});

test("kinds are separate: a conversation's words never answer a session query", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["shared phrase", "user"]));
    index.put("s1", "session", "1", said(["shared phrase", "user"]));

    expect([...index.search("shared phrase", "conversation", false).keys()]).toEqual(["c1"]);
    expect([...index.search("shared phrase", "session", false).keys()]).toEqual(["s1"]);
});

/* `extend` is the settle path and `put` is the backfill's: one appends a turn, the other re-states a source
 * whole. The distinction matters because a rewind SHORTENS a record, and an index that only ever appended would
 * keep answering with lines the conversation no longer contains. */
test("a settled turn extends a source; a rewind's re-statement drops what went", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["first turn", "user"]));
    index.extend("c1", "conversation", "2", said(["second turn", "user"]));

    expect(index.search("first turn", "conversation", false).has("c1")).toBe(true);
    expect(index.search("second turn", "conversation", false).has("c1")).toBe(true);
    expect(index.versions("conversation").get("c1")).toBe("2");

    // What a rewind does: re-state the source from what the record now holds.
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

// The version is what lets a backfill ask "is this still current" with one stat instead of a read.
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

// Two characters is the contract's floor, and below three the trigram index cannot narrow. It must still be
// correct, because "ci" and "db" are things people genuinely search for.
test("a two-character query is still answered correctly", () => {
    const index = fresh();
    index.put("c1", "conversation", "1", said(["check the ci run", "user"]));
    index.put("c2", "conversation", "1", said(["nothing matching", "user"]));

    expect([...index.search("ci", "conversation", false).keys()]).toEqual(["c1"]);
});
