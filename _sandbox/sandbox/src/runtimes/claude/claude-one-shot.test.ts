import { WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test, vi } from "vitest";
import type { Services } from "../../composition.js";
import { claudeOneShot } from "./claude-one-shot.js";

// Only query is faked; the rest of the SDK is real, since failure-sentences.ts's own logic is what's under test. The
// fake yields a generator (not a plain iterable), since the finally block closes it via .return().
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({ ...(await importOriginal<object>()), query }));
// Credential resolution is covered elsewhere; here it returns ok, so only the run is under test.
vi.mock("../../agent/providers/harness-credentials.js", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resolveHarnessCredentials: async () => ({ ok: true, credentials: {} }),
}));

const answering = (result: { readonly result: string; readonly is_error?: boolean }): void => {
    query.mockReturnValue(
        (async function* () {
            yield { type: "result", subtype: "success", is_error: false, ...result };
        })(),
    );
};

const ask = (): Promise<string> =>
    claudeOneShot({} as Services, {
        provider: "claude",
        prompt: "Name this session",
        cwd: WORKSPACE_ROOT,
        model: "claude-haiku-4-5",
        signal: new AbortController().signal,
    });

test("returns the model's answer", async () => {
    answering({ result: "Wire the fleet board broadcast" });
    await expect(ask()).resolves.toBe("Wire the fleet board broadcast");
});

// The CLI files an API failure as a success-subtype result carrying is_error, not a thrown error; every caller here
// treats the reply as data, so it must be converted to a thrown failure.
test("a result that reports an error is a failure, not an answer", async () => {
    answering({ result: "Failed to authenticate. API Error: 401 OAuth access token has been revoked", is_error: true });
    await expect(ask()).rejects.toThrow(/401/);
});

test("an errored result with nothing in it still fails rather than answering empty", async () => {
    answering({ result: "", is_error: true });
    await expect(ask()).rejects.toThrow("the model did not answer");
});

// Backstop for a failure reported as prose without the flag; a spent allowance arrives exactly that way.
test("a failure sentence is refused even in an unflagged result", async () => {
    answering({ result: "You've hit your session limit · resets 11:50pm (UTC)" });
    await expect(ask()).rejects.toThrow("You've hit your session limit · resets 11:50pm (UTC)");
});

test("a non-success subtype names the subtype it failed with", async () => {
    query.mockReturnValue(
        (async function* () {
            yield { type: "result", subtype: "error_during_execution", is_error: true, result: "" };
        })(),
    );
    await expect(ask()).rejects.toThrow(/error_during_execution/);
});

// The CLI's retry budget is sized for a live turn riding out a rate limit (up to 300 attempts, long delays); a one-shot
// helper must not wait it out the same way.

// Yields a retry frame then nothing, matching what the CLI does while it waits out the window.
const retrying = (retry: { readonly error: string; readonly retry_delay_ms: number }): void => {
    query.mockReturnValue(
        (async function* () {
            yield { type: "system", subtype: "api_retry", attempt: 1, max_retries: 300, error_status: 429, ...retry };
            await new Promise(() => {});
        })(),
    );
};

test("a spent allowance is terminal for a helper, not something to wait out", async () => {
    retrying({ error: "rate_limit", retry_delay_ms: 21_600_000 });
    await expect(ask()).rejects.toThrow(/usage limit/i);
});

test("an ordinary retry is ridden out only while it stays within a helper's patience", async () => {
    retrying({ error: "unknown", retry_delay_ms: 60_000 });
    await expect(ask()).rejects.toThrow(/retry deferred 60s/);
});

test("a brief retry is still worth waiting for: the answer after it is the answer", async () => {
    query.mockReturnValue(
        (async function* () {
            yield { type: "system", subtype: "api_retry", attempt: 1, max_retries: 300, error_status: null, error: "unknown", retry_delay_ms: 561 };
            yield { type: "result", subtype: "success", is_error: false, result: "Sandbox freezes · fix" };
        })(),
    );
    await expect(ask()).resolves.toBe("Sandbox freezes · fix");
});
