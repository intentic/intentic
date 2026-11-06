import type { TurnInput } from "../../../../seams/turn-starter.js";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { experimentArm } from "@intentic/agent-context/experiments";
import { coldTrimEligible, sessionBasis, trimDelivery } from "../cold-trim.js";
import { parseSession } from "../../../providers/claude/claude-session-copy.js";
import { PROMPT_CACHE_1H_MS, PROMPT_CACHE_5M_MS } from "../prompt-cache.js";
import { armOf, EXPERIMENTS } from "../../decide/experiments.js";

const turn: TurnInput = { prompt: "continue", agent: "claude", harness: "native", conversationId: "c", sessionId: "s" };
const clock = { at: 1000, ttlMs: 300_000 };
const eligible = (
    over: Partial<TurnInput> = {},
    now = 331_001,
    tokens: number | undefined = 100_001,
    cache: typeof clock | undefined = clock,
    held = false,
) => coldTrimEligible({ ...turn, ...over }, cache, tokens, 100_000, held, now);

test("only expired caches past the safety margin are cold", () => {
    expect(eligible()).toBe(true);
    expect(eligible({}, 301_000)).toBe(false);
    expect(eligible({}, 331_000)).toBe(false);
    expect(eligible({}, 200_000)).toBe(false);
    expect(eligible({}, 331_001, 100_001, { at: 331_000, ttlMs: 300_000 })).toBe(false);
});

test("unknown timing and small or unknown context stay whole", () => {
    expect(coldTrimEligible(turn, undefined, 100_001, 100_000, false, 331_001)).toBe(false);
    expect(eligible({}, 331_001, 100_001, { at: 1000, ttlMs: Number.NaN })).toBe(false);
    expect(eligible({}, 331_001, 100_001, { at: Number.NaN, ttlMs: 300_000 })).toBe(false);
    expect(eligible({}, 331_001, 100_000)).toBe(false);
    expect(coldTrimEligible(turn, clock, undefined, 100_000, false, 331_001)).toBe(false);
});

test("only ordinary native Claude session follow-ups can trim", () => {
    expect(eligible({ agent: "codex" })).toBe(false);
    expect(eligible({ agent: "codex", harness: "opencode" })).toBe(false);
    expect(eligible({ sessionId: undefined })).toBe(false);
    expect(eligible({ conversationId: undefined })).toBe(false);
    expect(eligible({ forkOf: { conversationId: "parent", keep: 1, files: "now" } })).toBe(false);
    expect(eligible({ resumeAt: "cut" })).toBe(false);
    expect(eligible({ resume: "trimmed" })).toBe(false);
    expect(eligible({}, 331_001, 100_001, clock, true)).toBe(false);
});

test("eligible conversations stamp either arm; ineligible turns stamp neither", () => {
    const settings = SandboxSettingsSchema.parse({});
    for (const arm of [true, false]) {
        const id = Array.from({ length: 100 }, (_, i) => `cold-${i}`).find((candidate) => experimentArm("cold-trim", candidate, 0.5) === arm)!;
        const assigned = armOf(EXPERIMENTS.coldTrim, settings, id);
        expect(EXPERIMENTS.coldTrim.stamps(eligible() ? { arm: assigned } : undefined)).toEqual({ coldTrimArm: arm });
        expect(EXPERIMENTS.coldTrim.stamps(eligible({}, 1000) ? { arm: assigned } : undefined)).toEqual({});
    }
    expect(EXPERIMENTS.coldTrim.stamps({ arm: true, cleared: 12 })).toEqual({ coldTrimArm: true, coldTrimmed: 12 });
    expect(armOf(EXPERIMENTS.coldTrim, SandboxSettingsSchema.parse({ coldTrim: false }), "c")).toBeUndefined();
    expect(armOf(EXPERIMENTS.coldTrim, SandboxSettingsSchema.parse({ coldTrimHoldout: 0 }), "c")).toBeUndefined();
});

test("delivery counts cleared results only when the runtime resumes the cold copy", () => {
    const trim = { turn, cold: true, event: { mode: "trim" as const, cleared: 12 }, stamps: { coldTrimArm: true, coldTrimmed: 12 } };
    expect(trimDelivery(trim, "s")).toEqual(trim);
    expect(trimDelivery(trim, undefined)).toEqual({ turn, stamps: { coldTrimArm: true }, event: { mode: "trim", fellBack: true } });
    const held = { ...trim, cold: false };
    expect(trimDelivery(held, undefined)).toEqual(held);
});

// One main-chain request as the CLI files it: when it ran, what it read, and what it wrote under which lifetime.
const request = (uuid: string, parentUuid: string | null, timestamp: string | undefined, write?: { m5?: number; h1?: number }) =>
    JSON.stringify({
        type: "assistant",
        uuid,
        parentUuid,
        ...(timestamp === undefined ? {} : { timestamp }),
        message: {
            content: [{ type: "text", text: "ok" }],
            usage: {
                input_tokens: 2,
                cache_read_input_tokens: 120_000,
                cache_creation_input_tokens: (write?.m5 ?? 0) + (write?.h1 ?? 0),
                output_tokens: 10,
                ...(write === undefined ? {} : { cache_creation: { ephemeral_5m_input_tokens: write.m5 ?? 0, ephemeral_1h_input_tokens: write.h1 ?? 0 } }),
            },
        },
    });
const chainOf = (...lines: string[]) => parseSession(lines.join("\n"));

test("a session file gives back the clock and context a restart wiped", () => {
    const basis = sessionBasis(chainOf(request("a", null, "2026-11-01T10:00:00.000Z", { m5: 500 }), request("b", "a", "2026-11-01T10:02:00.000Z")));
    expect(basis).toEqual({ promptCache: { at: Date.parse("2026-11-01T10:02:00.000Z"), ttlMs: PROMPT_CACHE_5M_MS }, contextTokens: 120_002 });
    expect(sessionBasis(chainOf(request("a", null, "2026-11-01T10:00:00.000Z", { h1: 500 })))?.promptCache?.ttlMs).toBe(PROMPT_CACHE_1H_MS);
});

test("a session that never names its lifetime runs under the longer one, and an unstamped request names no clock", () => {
    expect(sessionBasis(chainOf(request("a", null, "2026-11-01T10:00:00.000Z")))?.promptCache?.ttlMs).toBe(PROMPT_CACHE_1H_MS);
    expect(sessionBasis(chainOf(request("a", null, "2026-11-01T10:00:00.000Z", { m5: 1 }), request("b", "a", undefined)))).toBeUndefined();
    expect(sessionBasis(chainOf(JSON.stringify({ type: "user", uuid: "u", parentUuid: null, message: { content: "hi" } })))).toBeUndefined();
});
