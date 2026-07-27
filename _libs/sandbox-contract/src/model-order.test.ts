import { expect, test } from "vitest";
import { compareModelIds, compareUnrankedModelIds, familyOf, releaseOf, tierRankOf } from "./model-order.js";

/* The order every provider's catalog is served and browsed in. The rule exists because only Anthropic publishes
 * a ranking: the OpenAI-compatible endpoints behind Codex, Gemini, Kimi and Grok hand back a SET, and taking
 * their registry order for a preference is what opened the Codex group on GPT 5.4 Mini and started fresh Codex
 * conversations on whichever id sorted first. */

// A Codex catalog exactly as an OpenAI-compatible /v1/models hands it over: alphabetical, i.e. meaningless.
const CODEX = ["gpt-5.1-codex", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"];

test("ranks the frontier line above the cheap one and the newest release above its predecessors", () => {
    // The base line (no tier word) leads, newest first; the mini rung sinks under all of it regardless of how
    // recently it shipped — which is the whole decision a user makes in this list.
    expect(CODEX.toSorted(compareModelIds)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.1-codex", "gpt-5.4-mini"]);
});

test("lands the same models at the head and the tail whichever order the endpoint listed them in", () => {
    // Arrival order survives only as the tiebreak between two ids the rule ranks equally (the 5.6 siblings), so
    // an alphabetical registry and a reversed one can no longer disagree about which model the group opens on.
    for (const arrival of [CODEX.toSorted(), CODEX.toReversed()]) {
        const ordered = arrival.toSorted(compareModelIds);

        expect(ordered.slice(0, 2).toSorted()).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
        expect(ordered.at(-1)).toBe("gpt-5.4-mini");
    }
});

test("an unranked catalog settles its own ties, so the SAME sibling opens the group on every refresh", () => {
    // The measured failure: the translator's /v1/models hands sol/terra/luna back in a different order per
    // request, and the rule above ranks all three equally — same tier, same 5.6 release. Under plain stability
    // the catalog's head (i.e. the model a fresh conversation starts on) followed that reshuffling.
    const arrivals = [
        ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
        ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"],
        ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
    ];
    const heads = arrivals.map((arrival) => arrival.toSorted(compareUnrankedModelIds)[0]);

    expect(new Set(heads).size).toBe(1);
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
