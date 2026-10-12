import type { Logger } from "pino";
import { beginPulse, endPulse, noteRetryCause, pulseFrame, turnPulseOf } from "../turn-pulse.js";

// A turn retrying a refused provider for hours once left nothing between its start and its refusal (2026-10-11): each
// retry its loop reports is now on the turn's pulse, and on the log once per state, its repeats folded into a count.

const lines = (): { said: { level: string; fields: Record<string, unknown>; message: string }[]; logger: Pick<Logger, "info" | "warn"> } => {
    const said: { level: string; fields: Record<string, unknown>; message: string }[] = [];
    return {
        said,
        logger: {
            info: (fields: Record<string, unknown>, message: string) => void said.push({ level: "info", fields, message }),
            warn: (fields: Record<string, unknown>, message: string) => void said.push({ level: "warn", fields, message }),
        } as unknown as Pick<Logger, "info" | "warn">,
    };
};

const begin = (conversationId: string, turnId: string): void =>
    beginPulse({ conversationId, turnId, run: `run-${turnId}`, provider: "codex", harness: "claude-code", model: "gpt-x", startedAt: 1_000 });

test("a retry is on the pulse and on the log once per state, its repeats folded in", () => {
    const { said, logger } = lines();
    begin("c-retry", "t-retry");
    noteRetryCause("c-retry", "rate_limit");
    pulseFrame(logger, "c-retry", { kind: "provider_retry", attempt: 1, maxAttempts: 8, status: 429 }, 2_000);
    pulseFrame(logger, "c-retry", { kind: "provider_retry", attempt: 2, maxAttempts: 8, status: 429 }, 3_000);
    pulseFrame(logger, "c-retry", { kind: "provider_retry", attempt: 3, maxAttempts: 8, status: 429 }, 4_000);

    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({
        level: "warn",
        fields: { conversationId: "c-retry", turnId: "t-retry", run: "run-t-retry", provider: "codex", status: 429, cause: "rate_limit", attempt: 1, repeated: 0 },
    });
    expect(turnPulseOf("c-retry")).toMatchObject({ lastEventAt: 4_000, lastEvent: "provider_retry", retriesSinceAnswer: 3, upstream: { status: 429, attempt: 3 } });

    // A different status is a new state: said at once.
    pulseFrame(logger, "c-retry", { kind: "provider_retry", attempt: 4, status: 503 }, 5_000);
    expect(said.at(-1)?.fields).toMatchObject({ status: 503, attempt: 4 });
});

test("an answer after retries says so once, with how many it took", () => {
    const { said, logger } = lines();
    begin("c-back", "t-back");
    pulseFrame(logger, "c-back", { kind: "provider_retry", attempt: 1, status: 529 }, 2_000);
    pulseFrame(logger, "c-back", { kind: "delta", text: "here" }, 3_000);
    pulseFrame(logger, "c-back", { kind: "delta", text: " again" }, 3_100);

    expect(said.map((line) => line.message)).toEqual([
        "turn: the provider refused or failed a request, the loop is retrying it",
        "turn: the provider answered again after retries",
    ]);
    expect(said[1]?.fields).toMatchObject({ turnId: "t-back", retries: 1, lastStatus: 529 });
    expect(turnPulseOf("c-back")).toMatchObject({ retriesSinceAnswer: 0, lastEventAt: 3_100 });
});

test("an ended turn's pulse stays, marked ended, until the conversation's next turn replaces it", () => {
    const { said, logger } = lines();
    begin("c-end", "t-one");
    expect(endPulse("c-end", "someone-else")).toBeUndefined();
    expect(endPulse("c-end", "t-one", 9_000)).toMatchObject({ turnId: "t-one", endedAt: 9_000 });
    // Frames after the end move nothing.
    pulseFrame(logger, "c-end", { kind: "provider_retry", attempt: 1 }, 10_000);
    expect(said).toEqual([]);
    expect(turnPulseOf("c-end")?.lastEventAt).toBe(1_000);

    begin("c-end", "t-two");
    expect(turnPulseOf("c-end")).toMatchObject({ turnId: "t-two", retriesSinceAnswer: 0 });
    expect(turnPulseOf("c-end")?.endedAt).toBeUndefined();
});
