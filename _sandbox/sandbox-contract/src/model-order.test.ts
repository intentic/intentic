import { expect, test } from "vitest";
import { compareCheapestFirst, compareModelIds, compareUnrankedModelIds, familyOf, namesThinking, releaseOf, tierRankOf } from "./model-order.js";

/* The order every provider's catalog is served and browsed in. The rule exists because only Anthropic publishes
 * a ranking: the OpenAI-compatible endpoints behind Codex, Gemini, Kimi and Grok hand back a SET, and taking
 * their registry order for a preference is what opened the Codex group on GPT 5.4 Mini and started fresh Codex
 * conversations on whichever id sorted first. */

// A Codex catalog exactly as an OpenAI-compatible /v1/models hands it over: alphabetical, i.e. meaningless.
const CODEX = ["gpt-5.1-codex", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"];

test("ranks the frontier line above the cheap one and the newest release above its predecessors", () => {
    // The base line (no tier word) leads, newest first; the mini rung sinks under all of it regardless of how
    // recently it shipped — which is the whole decision a user makes in this list.
    expect(CODEX.toSorted(compareModelIds)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.1-codex", "gpt-5.4-mini"]);
});

test("orders a release's named tiers strongest-first whichever order the endpoint listed them in", () => {
    for (const arrival of [CODEX.toSorted(), CODEX.toReversed()]) {
        const ordered = arrival.toSorted(compareModelIds);

        expect(ordered.slice(0, 3)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
        expect(ordered.at(-1)).toBe("gpt-5.4-mini");
    }
});

test("keeps release-local tiers below the next generation and above the previous one", () => {
    expect(["gpt-5.6-luna", "gpt-5.5", "gpt-5.7", "gpt-5.6-sol"].toSorted(compareModelIds)).toEqual([
        "gpt-5.7",
        "gpt-5.6-sol",
        "gpt-5.6-luna",
        "gpt-5.5",
    ]);
});

test("the Codex release-tier order is stable across catalog refreshes", () => {
    const arrivals = [
        ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
        ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"],
        ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
    ];

    for (const arrival of arrivals) {
        expect(arrival.toSorted(compareUnrankedModelIds)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    }
    // Same rule, so ranking still outranks the tiebreak: the mini rung stays at the tail, under every sibling.
    expect(["gpt-5.4-mini", ...arrivals[0]!].toSorted(compareUnrankedModelIds).at(-1)).toBe("gpt-5.4-mini");
});

test("leaves a RANKED catalog's ties alone — the id tiebreak is for sets, and Anthropic publishes an opinion", () => {
    // compareUnrankedModelIds would seat claude-fable-5 ahead of claude-opus-5 on the id alone. Anthropic's
    // catalog arrives newest-first, so that order is a fact about the provider, not a leftover to be broken.
    expect(["claude-opus-5", "claude-fable-5"].toSorted(compareModelIds)).toEqual(["claude-opus-5", "claude-fable-5"]);
    expect(["claude-opus-5", "claude-fable-5"].toSorted(compareUnrankedModelIds)).toEqual(["claude-fable-5", "claude-opus-5"]);
});

test("reads each vendor's tier vocabulary, not just Claude's", () => {
    expect(["gemini-3-flash", "gemini-3-flash-lite", "gemini-3-pro"].toSorted(compareModelIds)).toEqual([
        "gemini-3-pro",
        "gemini-3-flash",
        "gemini-3-flash-lite",
    ]);
    expect(["grok-4-fast", "grok-code-fast-1", "grok-4", "grok-3"].toSorted(compareModelIds)).toEqual([
        "grok-4",
        "grok-3",
        "grok-4-fast",
        "grok-code-fast-1",
    ]);
    expect(["kimi-k2-turbo-preview", "kimi-k2-0711-preview", "kimi-k2-mini"].toSorted(compareModelIds)).toEqual([
        "kimi-k2-0711-preview",
        "kimi-k2-turbo-preview",
        "kimi-k2-mini",
    ]);
});

test("reads Kimi's k-prefixed generation so K3 leads the K2.x catalog", () => {
    const catalog = ["kimi-k2.6", "kimi-k2.7-code-highspeed", "kimi-k3", "kimi-k2.7-code"];

    expect(releaseOf("kimi-k3")).toEqual({ version: [3], date: 0 });
    expect(familyOf("kimi-k3")).toBe(familyOf("kimi-k2.6"));
    expect(catalog.toSorted(compareUnrankedModelIds)).toEqual(["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"]);
});

test("the rightmost tier word wins, because tier words compose", () => {
    // flash-lite is the cheap end of Flash, codex-max the frontier end of Codex — reading the leftmost word
    // instead would file both under the tier they modify.
    expect(tierRankOf(familyOf("gemini-3-flash-lite"))).toBe(tierRankOf("lite"));
    expect(tierRankOf(familyOf("gpt-5.1-codex-max"))).toBe(tierRankOf("max"));
});

test("leads with a family carrying no tier word at all, so a brand-new flagship is never buried by its novelty", () => {
    // The precise inverse of the ranking this replaced, which sank unrecognized ids BELOW the everyday tier.
    expect(["claude-sonnet-5", "claude-mythos-1", "claude-opus-5"].toSorted(compareModelIds)[0]).toBe("claude-mythos-1");
});

test("files a re-served open-weights model on the cheap rung, not at the head of the catalog it visits", () => {
    // Google's channel vends gpt-oss beside Gemini and Claude. It carries no tier word of its own, so the
    // lead-the-unknown rule would open that whole section on it — above Opus.
    expect(["gpt-oss-120b-medium", "claude-opus-4-6-thinking", "gemini-pro-agent"].toSorted(compareModelIds)).toEqual([
        "claude-opus-4-6-thinking",
        "gemini-pro-agent",
        "gpt-oss-120b-medium",
    ]);
});

test("keeps the arrival order between ids the rule cannot separate — Anthropic's catalog IS ranked", () => {
    // Same tier, same version: nothing here outranks the order the provider itself reported.
    expect(["claude-opus-5", "claude-fable-5"].toSorted(compareModelIds)).toEqual(["claude-opus-5", "claude-fable-5"]);
    expect(["claude-fable-5", "claude-opus-5"].toSorted(compareModelIds)).toEqual(["claude-fable-5", "claude-opus-5"]);
});

test("groups every version of a family under one key, whatever shape its id takes", () => {
    expect(familyOf("claude-opus-4-8")).toBe(familyOf("claude-opus-5"));
    expect(familyOf("claude-haiku-4-5-20251001")).toBe(familyOf("claude-haiku-4-5"));
    expect(familyOf("gpt-5.1")).toBe(familyOf("gpt-5"));
    // Distinct lines stay distinct: a variant word is part of the family, not a version of the base one.
    expect(familyOf("gpt-5.1-codex")).not.toBe(familyOf("gpt-5.1"));
});

test("stands an id with nothing but numbers (and an ACP row's empty one) as its own family", () => {
    expect(familyOf("4-5")).toBe("4-5");
    expect(familyOf("")).toBe("");
});

test("holds date stamps apart from version components, or a dated build outranks the point release after it", () => {
    // The failure this prevents: claude-opus-4-1-20250805 (Opus 4.1) read as (4,1,20250805) loses to
    // claude-opus-4-20250514 (Opus 4.0) read as (4,20250514) — the older model, by six digits.
    expect(releaseOf("claude-opus-4-1-20250805")).toEqual({ version: [4, 1], date: 20250805 });
    expect(["claude-opus-4-20250514", "claude-opus-4-1-20250805"].toSorted(compareModelIds)).toEqual([
        "claude-opus-4-1-20250805",
        "claude-opus-4-20250514",
    ]);
});

test("breaks a version tie by date stamp, so two builds of one release still order", () => {
    expect(["claude-haiku-4-5-20251001", "claude-haiku-4-5-20260210"].toSorted(compareModelIds)).toEqual([
        "claude-haiku-4-5-20260210",
        "claude-haiku-4-5-20251001",
    ]);
});

test("reads a longer version as the newer one, so 5.1 outranks 5", () => {
    expect(["gpt-5", "gpt-5.1"].toSorted(compareModelIds)).toEqual(["gpt-5.1", "gpt-5"]);
});

test("sorts an unversioned rolling alias under the releases that name their version", () => {
    // `kimi-latest` claims no release; guessing one for it would seat it above models that do say what they are.
    expect(releaseOf("kimi-latest").version).toEqual([]);
    expect(["kimi-latest", "kimi-k2-0711-preview"].toSorted(compareModelIds)).toEqual(["kimi-k2-0711-preview", "kimi-latest"]);
});

// --- the cheap end (compareCheapestFirst) ---------------------------------------------------------------
// What the quick model behind a one-click helper resolves against: the same tier scale, read for the weakest
// row instead of the strongest.

test("opens on the efficient rung and buries the frontier one — the exact inverse of the picker's order", () => {
    const claude = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

    expect(claude.toSorted(compareCheapestFirst)).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"]);
    expect(claude.toSorted(compareModelIds)).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
});

test("keeps an UNRANKED family off the cheap end, where a plain reversal would have seated it first", () => {
    // The whole reason this is not `-compareModelIds`. An id with no tier word is the provider's base line, and
    // an unheard-of family is likelier the next flagship than the next budget tier — so both orders agree it is
    // not the efficient rung, and a helper never spends frontier money on a commit message.
    expect(["gpt-5.6", "gpt-5.4-mini"].toSorted(compareCheapestFirst)).toEqual(["gpt-5.4-mini", "gpt-5.6"]);
    expect(["claude-mythos-1", "claude-haiku-4-5", "claude-sonnet-5"].toSorted(compareCheapestFirst).at(-1)).toBe("claude-mythos-1");
});

test("takes the NEWEST build of the cheap rung, not merely any of them", () => {
    // Within one tier the release rule runs unchanged: cheap is a tier, not an excuse to serve a stale model.
    expect(["claude-haiku-4-5-20251001", "claude-haiku-4-5-20260210"].toSorted(compareCheapestFirst)[0]).toBe("claude-haiku-4-5-20260210");
    expect(["gemini-3-flash-lite", "gemini-2-flash-lite"].toSorted(compareCheapestFirst)[0]).toBe("gemini-3-flash-lite");
});

test("finds each vendor's own cheap rung, including a re-served open-weights row", () => {
    expect(["gemini-3-pro", "gemini-3-flash", "gemini-3-flash-lite"].toSorted(compareCheapestFirst)[0]).toBe("gemini-3-flash-lite");
    // Google's channel vends gpt-oss beside Gemini's own line; it is there to be the cheap option, and `oss`
    // is what says so — without that word the id carries no tier at all and would sink to the bottom.
    expect(["claude-opus-4-6-thinking", "gpt-oss-120b-medium"].toSorted(compareCheapestFirst)[0]).toBe("gpt-oss-120b-medium");
    expect(["grok-4", "grok-4-fast"].toSorted(compareCheapestFirst)[0]).toBe("grok-4-fast");
});

test("reads a release-local tier ladder from the cheap end too", () => {
    expect(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].toSorted(compareCheapestFirst)[0]).toBe("gpt-5.6-luna");
});

test("refuses the thinking variant of a model, however new it is", () => {
    /* The bug this rule exists for, in the shape the live catalog actually publishes it: a routed channel vends
     * one row per thinking LEVEL, and the newest row of the cheapest model was the high one — so the ladder
     * whose whole job is to be the cheap rung reached for the most expensive reading of it, and a commit
     * message that takes 2s took closer to 30. */
    expect(["gemini-3.6-flash-high", "gemini-3.5-flash-extra-low"].toSorted(compareCheapestFirst)[0]).toBe("gemini-3.5-flash-extra-low");
    // …and it is the LEVEL that decides, not the release: same model, quieter row wins.
    expect(["gemini-3.5-flash-high", "gemini-3.5-flash-minimal"].toSorted(compareCheapestFirst)[0]).toBe("gemini-3.5-flash-minimal");
    // Tier still outranks it: a thinking cheap model beats a silent expensive one, which is the order that
    // keeps this from quietly promoting a frontier row for being unannotated.
    expect(["gemini-3-pro", "gemini-3.6-flash-high"].toSorted(compareCheapestFirst)[0]).toBe("gemini-3.6-flash-high");
    // An id nobody annotated is not accused of thinking, and is not credited with silence either: it sits
    // between the stated ends.
    expect(["gemini-3-flash", "gemini-3.5-flash-low"].toSorted(compareCheapestFirst)[0]).toBe("gemini-3.5-flash-low");
    expect(["gemini-3-flash", "gemini-3.6-flash-high"].toSorted(compareCheapestFirst)[0]).toBe("gemini-3-flash");
});

test("names the thinking rows, and only those", () => {
    // What a settings row shows beside a pin, so that choosing one is a choice rather than an accident.
    expect(namesThinking("gemini-3.6-flash-high")).toBe(true);
    expect(namesThinking("gemini-3.1-pro-low")).toBe(false);
    expect(namesThinking("gemini-3.5-flash-extra-low")).toBe(false);
    expect(namesThinking("claude-haiku-4-5-20251001")).toBe(false);
    expect(namesThinking("gpt-5.6-luna")).toBe(false);
    // An effort word that is not `high` still names one; so does the on/off form a channel vends beside its
    // quiet row.
    expect(namesThinking("gpt-oss-120b-medium")).toBe(true);
    expect(namesThinking("kimi-k2-thinking")).toBe(true);
    expect(namesThinking("kimi-k2")).toBe(false);
});

test("falls back on the newest release for a catalog that publishes no cheap tier at all", () => {
    // Kimi names no tier word anywhere, so every row is UNRANKED and the tier term cancels. Serving the newest
    // of what it does publish is the honest answer — there is no cheaper rung to find.
    expect(["kimi-k2-0711-preview", "kimi-k2-0905-preview"].toSorted(compareCheapestFirst)[0]).toBe("kimi-k2-0905-preview");
});
