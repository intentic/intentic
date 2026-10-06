import { tokensOfChars } from "@intentic/base/format";
// Old tool results replaced with a placeholder in a long Claude conversation's request, on its way through the gateway,
// a chunk at a time. The `toolResultClearing` setting switches it on and its holdout measures it (decide/experiments.ts).
//
// Why a chunk at a time, and why here: a change anywhere in a prompt breaks the provider's cache from that point on, so
// the next call writes everything after it at 12.5 times the price of reading it. The API's own clearing
// (clear_tool_uses_20250919) is stateless: above its trigger it clears all but the last N results on every request,
// so the boundary moves on every call and every call rewrites the kept tail. Simulated on 543 real sessions (week to
// 2026-10-04), that RAISED prompt cost for any window that keeps more than three results (+20% at ten, +196% at fifty),
// and the CLI exposes no switch for it anyway. Moving the boundary only once a whole chunk has piled up behind the
// kept window breaks the cache once per chunk instead: the same simulation read 11-18% less prompt cost and a mean
// prompt of ~190-205k tokens instead of 255k.
//
// Stateless all the same: the boundary is a pure function of the history the request carries, so a daemon restart, a
// subagent's own history and the CLI's side requests (titles, summaries) each get the answer their own history implies,
// and a history that has not grown by a chunk gets exactly the same body as the call before it.

import { isList, isRecord, isText, type Json } from "./protocols/walk.js";

// Tunables, as simulated over the session record: trigger 100k, keep 20, chunk 40k read the best of the chunked runs.
export const CLEARING = {
    // A prompt estimated under this many tokens is sent as it came.
    triggerTokens: 100_000,
    // The most recent tool results always stay whole: the work in hand.
    keepResults: 20,
    // The boundary moves only once at least this many tokens of results lie between it and the kept window.
    chunkTokens: 40_000,
    // A result shorter than this is never replaced: it saves less than the placeholder costs in the model's confidence.
    minResultChars: 1_000,
} as const;

export type ClearingLimits = { readonly [K in keyof typeof CLEARING]: number };

// What an image is reckoned at: a screenshot is ~1,500 tokens whatever its bytes.
const IMAGE_CHARS = 6_000;

// What the model reads where a result was.
export const CLEARED_PLACEHOLDER = "[Earlier tool result cleared to keep the context small. Run the tool again if you need it.]";

export interface ClearingOutcome {
    // The request to send: the same object when nothing was cleared.
    readonly body: Json;
    readonly cleared: number;
    readonly clearedTokens: number;
}

// How much of the prompt one block of a tool result's content is, in characters.
const blockChars = (block: Json): number => {
    if (isRecord(block) && block["type"] === "image") {
        return IMAGE_CHARS;
    }
    const text = isRecord(block) ? block["text"] : undefined;
    return isText(text) ? text.length : JSON.stringify(block).length;
};

// How much of the prompt one tool result's content is, in characters.
const charsOf = (content: Json | undefined): number => {
    if (isText(content)) {
        return content.length;
    }
    return isList(content) ? content.reduce((sum: number, block) => sum + blockChars(block), 0) : 0;
};

interface ResultAt {
    readonly message: number;
    readonly block: number;
    readonly tokens: number;
    readonly clearable: boolean;
}

// Every tool result the history carries, oldest first.
const resultsOf = (messages: readonly Json[], limits: ClearingLimits): ResultAt[] => {
    const results: ResultAt[] = [];
    for (const [message, entry] of messages.entries()) {
        const content = isRecord(entry) && entry["role"] === "user" ? entry["content"] : undefined;
        if (!isList(content)) {
            continue;
        }
        for (const [block, part] of content.entries()) {
            if (isRecord(part) && part["type"] === "tool_result") {
                const chars = charsOf(part["content"]);
                results.push({ message, block, tokens: tokensOfChars(chars), clearable: chars >= limits.minResultChars });
            }
        }
    }
    return results;
};

// How many of the oldest clearable results to replace: the longest run of them that fits under the last whole chunk of
// what lies behind the kept window. Grows only when that mass crosses another multiple of the chunk.
const boundaryOf = (results: readonly ResultAt[], limits: ClearingLimits): ResultAt[] => {
    const behind = results.slice(0, Math.max(0, results.length - limits.keepResults)).filter((result) => result.clearable);
    const mass = behind.reduce((sum, result) => sum + result.tokens, 0);
    const budget = Math.floor(mass / limits.chunkTokens) * limits.chunkTokens;
    const cleared: ResultAt[] = [];
    let spent = 0;
    for (const result of behind) {
        if (spent + result.tokens > budget) {
            break;
        }
        spent += result.tokens;
        cleared.push(result);
    }
    return cleared;
};

/** An Anthropic Messages request with its old tool results replaced; the body itself when nothing is due. */
export const clearToolResults = (body: Json, limits: ClearingLimits = CLEARING): ClearingOutcome => {
    const untouched = { body, cleared: 0, clearedTokens: 0 };
    const messages = isRecord(body) ? body["messages"] : undefined;
    if (!isRecord(body) || !isList(messages) || tokensOfChars(JSON.stringify(body).length) < limits.triggerTokens) {
        return untouched;
    }
    const cleared = boundaryOf(resultsOf(messages, limits), limits);
    if (cleared.length === 0) {
        return untouched;
    }
    const replaced: Json[] = [...messages];
    for (const { message, block } of cleared) {
        const entry = replaced[message];
        const content = isRecord(entry) ? entry["content"] : undefined;
        if (!isRecord(entry) || !isList(content)) {
            continue;
        }
        // The block keeps everything but what it said: its id pairs it with the call, and a cache mark stays put.
        const parts = content.map((part, at) => (at === block && isRecord(part) ? { ...part, content: CLEARED_PLACEHOLDER } : part));
        replaced[message] = { ...entry, content: parts };
    }
    return {
        body: { ...body, messages: replaced },
        cleared: cleared.length,
        clearedTokens: Math.round(cleared.reduce((sum, result) => sum + result.tokens, 0)),
    };
};
