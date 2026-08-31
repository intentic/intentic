import { WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test, vi } from "vitest";
import { runOneShot } from "./one-shot.js";

/* Only `query` is faked: the rest of the SDK is the real module, because USAGE_LIMIT_ERROR_PREFIXES behind
 * failure-sentences.ts is precisely the part worth not inventing here. The fake yields a generator rather than
 * a plain async iterable: the finally block closes the session through `.return()`. */
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({ ...(await importOriginal<object>()), query }));

const answering = (result: { readonly result: string; readonly is_error?: boolean }): void => {
    query.mockReturnValue(
        (async function* () {
            yield { type: "result", subtype: "success", is_error: false, ...result };
        })(),
    );
};

const ask = (): Promise<string> =>
    runOneShot({
        prompt: "Name this session",
        cwd: WORKSPACE_ROOT,
        model: "claude-haiku-4-5",
        credentials: {},
        signal: new AbortController().signal,
    });

test("returns the model's answer", async () => {
    answering({ result: "Wire the fleet board broadcast" });
    await expect(ask()).resolves.toBe("Wire the fleet board broadcast");
});

/* A SUCCESS SUBTYPE IS NOT A SUCCESS: the CLI files an API failure as a success-subtype result carrying
 * `is_error` and the provider's sentence. Every caller here uses the reply AS DATA, so a failure has to arrive
 * as one: returning it is what named four fleet cards after a revoked token (failure-sentences.ts). The
 * sentence rides along on the throw because it names the credential (or the reset) a caller's UI can act on. */
test("a result that reports an error is a failure, not an answer", async () => {
    answering({ result: "Failed to authenticate. API Error: 401 OAuth access token has been revoked", is_error: true });
    await expect(ask()).rejects.toThrow(/401/);
});

test("an errored result with nothing in it still fails rather than answering empty", async () => {
    answering({ result: "", is_error: true });
    await expect(ask()).rejects.toThrow("the model did not answer");
});

// The backstop for a condition reported as prose without the flag: a spent allowance arrives exactly that way.
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

/* THE RETRY THAT NEVER ENDS. The CLI's retry budget is sized for a TURN riding out a rate limit: 300 attempts,
 * and on a spent allowance a delay set to the closed window's remaining lifetime. A helper skipping those frames
 * waits the whole six hours: measured on a live sandbox, 14 CLI processes were resident, the oldest an hour old,
 * and not one session title had ever been written. Both tests below hang forever against the old loop. */

// A retry that yields no result afterwards: exactly what the CLI does while it waits out the window.
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
