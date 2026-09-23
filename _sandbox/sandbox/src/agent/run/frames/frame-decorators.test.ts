import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { describe, expect, test } from "bun:test";
import { abortSuppresses, completeCacheTtl, decorateFrame, silenceOf, silentEnding, stampAttribution, type TurnSilence, withSilentEnding } from "./frame-decorators.js";
import { createTurnFrames } from "./frame-reducers.js";

const both = { account: "acct-1", actor: "ada@example.com" };

describe("attribution", () => {
    const stamped: [string, AgentEvent, AgentEvent][] = [
        ["a session", { kind: "session", sessionId: "s" }, { kind: "session", sessionId: "s", ...both }],
        ["a usage frame", { kind: "usage", costUsd: 1 }, { kind: "usage", costUsd: 1, ...both }],
        ["a rate-limit reading", { kind: "rate_limit_info", status: "allowed" }, { kind: "rate_limit_info", status: "allowed", ...both }],
        ["an account reading", { kind: "account_usage", windows: [] }, { kind: "account_usage", windows: [], ...both }],
    ];
    test.each(stamped)("stamps %s", (_case, event, out) => {
        expect(stampAttribution(event, both)).toStrictEqual(out);
    });

    test("leaves every other frame alone, as the same object", () => {
        const delta: AgentEvent = { kind: "delta", text: "hi" };
        expect(stampAttribution(delta, both)).toBe(delta);
    });

    test("an empty attribution adds nothing, and a named account replaces the runtime's own", () => {
        expect(stampAttribution({ kind: "session", sessionId: "s", account: "runtime" }, {})).toStrictEqual({ kind: "session", sessionId: "s", account: "runtime" });
        expect(stampAttribution({ kind: "session", sessionId: "s", account: "runtime" }, { account: "daemon" })).toStrictEqual({
            kind: "session",
            sessionId: "s",
            account: "daemon",
        });
    });
});

describe("cache TTL", () => {
    const frames: [string, string, boolean, AgentEvent][] = [
        ["a Claude subscription writes an hour", "claude", true, { kind: "context_usage", tokens: 1, contextWindow: 9, cachedAt: 100, cacheTtlMs: 3_600_000 }],
        ["a Claude key writes five minutes", "claude", false, { kind: "context_usage", tokens: 1, contextWindow: 9, cachedAt: 100, cacheTtlMs: 300_000 }],
        ["a provider nobody publishes drops the instant", "codex", true, { kind: "context_usage", tokens: 1, contextWindow: 9 }],
    ];
    test.each(frames)("%s", (_case, provider, oauth, out) => {
        expect(completeCacheTtl({ kind: "context_usage", tokens: 1, contextWindow: 9, cachedAt: 100 }, provider, oauth)).toStrictEqual(out);
    });

    test("a measured TTL stands, and a frame with no instant is not given one", () => {
        expect(completeCacheTtl({ kind: "context_usage", tokens: 1, contextWindow: 9, cachedAt: 100, cacheTtlMs: 5 }, "claude", true)).toStrictEqual({
            kind: "context_usage",
            tokens: 1,
            contextWindow: 9,
            cachedAt: 100,
            cacheTtlMs: 5,
        });
        expect(completeCacheTtl({ kind: "context_usage", tokens: 1, contextWindow: 9 }, "claude", true)).toStrictEqual({ kind: "context_usage", tokens: 1, contextWindow: 9 });
    });

    test("any other frame passes as it is", () => {
        const usage: AgentEvent = { kind: "usage", costUsd: 1 };
        expect(completeCacheTtl(usage, "claude", true)).toBe(usage);
    });
});

test("a decorated frame takes both rewrites, and neither touches the other's kinds", () => {
    const turn = { attribution: both, provider: "claude", oauth: true };
    expect(decorateFrame({ kind: "usage", costUsd: 1 }, turn)).toStrictEqual({ kind: "usage", costUsd: 1, ...both });
    expect(decorateFrame({ kind: "context_usage", tokens: 1, contextWindow: 9, cachedAt: 100 }, turn)).toStrictEqual({
        kind: "context_usage",
        tokens: 1,
        contextWindow: 9,
        cachedAt: 100,
        cacheTtlMs: 3_600_000,
    });
});

const suppressions: [string, AgentEvent, boolean, boolean][] = [
    ["an error after an abort", { kind: "error", message: "aborted" }, true, true],
    ["an error before one", { kind: "error", message: "died" }, false, false],
    ["anything else after an abort", { kind: "done" }, true, false],
];
test.each(suppressions)("abort suppression: %s", (_case, event, aborted, suppressed) => {
    expect(abortSuppresses(event, aborted)).toBe(suppressed);
});

describe("a silent ending", () => {
    const quiet: TurnSilence = {
        conversationId: "c",
        aborted: false,
        failed: false,
        answered: true,
        kinds: new Set(["tool_call", "done"]),
        proseChars: 0,
        filesEdited: 0,
        toolCalls: 3,
    };
    const tail = "no reply and no change to a file. Nothing failed: the session is intact, so carrying on continues from where it stopped.";

    const endings: [string, Partial<TurnSilence>, string | undefined][] = [
        ["counts the calls it made", {}, `The turn ended with nothing to show for it: 3 tool calls and then a stop, ${tail}`],
        ["says one call in the singular", { toolCalls: 1 }, `The turn ended with nothing to show for it: 1 tool call and then a stop, ${tail}`],
        ["says when it never got past a thought", { toolCalls: 0 }, `The turn ended with nothing to show for it: the model started and then stopped, ${tail}`],
        ["is none without a conversation", { conversationId: undefined }, undefined],
        ["is none for a stopped turn", { aborted: true }, undefined],
        ["is none for one that already failed", { failed: true }, undefined],
        ["is none for one never answered", { answered: false }, undefined],
        ["is none once a file changed", { filesEdited: 1 }, undefined],
        ["is none once it spoke", { proseChars: 1 }, undefined],
        ["is none once it parked on a card", { kinds: new Set(["question"]) }, undefined],
    ];
    test.each(endings)("%s", (_case, change, sentence) => {
        expect(silentEnding({ ...quiet, ...change })).toBe(sentence);
    });
});

test("a turn's silence is read off its frames, its ledgers and how it ended", () => {
    const frames = createTurnFrames(WORKSPACE_ROOT, undefined);
    const stream: AgentEvent[] = [
        { kind: "delta", text: "four" },
        { kind: "tool_call", id: "1", name: "Read", category: "read", status: "completed" },
        { kind: "tool_call", id: "2", name: "Edit", category: "edit", status: "completed", locations: [{ path: "/work/a.ts" }] },
        { kind: "error", message: "died" },
    ];
    for (const event of stream) {
        frames.note(event);
    }
    expect(silenceOf(frames, { conversationId: "c", aborted: true })).toStrictEqual({
        conversationId: "c",
        aborted: true,
        failed: true,
        proseChars: 4,
        kinds: new Set(["delta", "tool_call", "error"]),
        answered: true,
        filesEdited: 1,
        toolCalls: 2,
    });
    expect(silenceOf(createTurnFrames(WORKSPACE_ROOT, undefined), { conversationId: undefined, aborted: false })).toStrictEqual({
        conversationId: undefined,
        aborted: false,
        failed: false,
        proseChars: 0,
        kinds: new Set(),
        answered: false,
        filesEdited: 0,
        toolCalls: 0,
    });
});

describe("the injected failure", () => {
    const stream = async function* (): AsyncGenerator<AgentEvent> {
        yield { kind: "delta", text: "x" };
        yield { kind: "done" };
    };
    const drain = async (frames: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
        const out: AgentEvent[] = [];
        for await (const frame of frames) {
            out.push(frame);
        }
        return out;
    };

    test("goes out uncoded, just ahead of done", async () => {
        expect(await drain(withSilentEnding(stream(), () => "nothing to show"))).toStrictEqual([
            { kind: "delta", text: "x" },
            { kind: "error", message: "nothing to show" },
            { kind: "done" },
        ]);
    });

    test("is asked only at done, and adds nothing when the turn was not silent", async () => {
        let asked = 0;
        const frames = await drain(
            withSilentEnding(stream(), () => {
                asked += 1;
                return undefined;
            }),
        );
        expect(frames).toStrictEqual([{ kind: "delta", text: "x" }, { kind: "done" }]);
        expect(asked).toBe(1);
    });
});
