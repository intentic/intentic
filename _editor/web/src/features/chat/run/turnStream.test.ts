import type { AttachFrame } from "@intentic/sandbox-contract";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { followRun, type RunRenderer, type TurnContext } from "./turnStream";

// The daemon's attach, as a suite scripts it: each call takes the next opening off the list.
const attach = jest.fn<(input: unknown, options?: { readonly signal?: AbortSignal }) => Promise<AsyncIterable<AttachFrame>>>();
jest.mock("../../../client/sandbox/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        agent: {
            // SAFETY: the suite scripts attach's answer itself; the client's own option and answer types are waived here only.
            attach: ((input: unknown, options?: { readonly signal?: AbortSignal }) => attach(input, options)) as never,
        },
    }),
}));

const TURN: TurnContext = { run: `run-1`, provider: `claude`, account: undefined, harness: `claude-code` };
const renderer: RunRenderer = { attached: () => TURN, entry: () => undefined };

// An attach that engages (its head arrives), delivers `entries` rows, and then drops without the run's `end`.
const engagedThenDropped = async function* (entries = 0): AsyncGenerator<AttachFrame> {
    yield { kind: `attached`, run: `run-1`, startedAt: 0, seq: 0, rows: [] };
    for (let seq = 1; seq <= entries; seq += 1) {
        yield { kind: `patch`, seq, patch: { op: `text`, index: 0, text: `more` } };
    }
    throw new Error(`socket closed`);
};

beforeEach(() => {
    jest.useFakeTimers();
    attach.mockReset();
});

afterEach(() => {
    jest.useRealTimers();
});

describe(`followRun`, () => {
    it(`ends at once when stopped during the backoff after a failed re-attach, not when the wait runs out`, async () => {
        // The first attach delivered a row, so its drop re-attaches at once; that one fails on the network.
        attach.mockResolvedValueOnce(engagedThenDropped(1)).mockRejectedValue(new TypeError(`Failed to fetch`));
        const controller = new AbortController();
        // Widened by the cast: the callback assigns it, which narrowing from the initializer would not see.
        let ended = `pending` as boolean | undefined | `pending`;
        void followRun(`cnv-1`, `run-1`, renderer, controller, undefined).then((end) => {
            ended = end;
        });
        // Engaged, dropped, re-attached into a network failure: now in the ladder's wait (at least its 500ms floor).
        await advanceTimersByTimeAsync(0);
        expect(attach).toHaveBeenCalledTimes(2);
        controller.abort();
        await advanceTimersByTimeAsync(0);
        expect(ended).toBe(true);
        // Nothing is tried after the stop.
        await advanceTimersByTimeAsync(10_000);
        expect(attach).toHaveBeenCalledTimes(2);
    });

    it(`ends at once when stopped during the wait after an attach that delivered nothing`, async () => {
        attach.mockImplementationOnce(async () => engagedThenDropped()).mockImplementation(async () => (async function* () {})());
        const controller = new AbortController();
        // Widened by the cast: the callback assigns it, which narrowing from the initializer would not see.
        let ended = `pending` as boolean | undefined | `pending`;
        void followRun(`cnv-1`, `run-1`, renderer, controller, undefined).then((end) => {
            ended = end;
        });
        await advanceTimersByTimeAsync(0);
        // First attach engaged and dropped; its empty round is waiting out the ladder.
        expect(ended).toBe(`pending`);
        controller.abort();
        await advanceTimersByTimeAsync(0);
        expect(ended).toBe(true);
    });
});
