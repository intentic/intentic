// The connection loop holds one `/events` stream and reconnects on failure. These pin what a stop, a switch and the
// watchdog end: a stop ends the backoff with it and opens nothing after itself, a switch mid-failure is not reported
// against the box switched to, and the watchdog speaks only for the stream it watches; and how fast it redials, and how
// often it asks for the list, while a wake is pending and outside one.
import { advanceTimersByTimeAsync, waitFor } from "@intentic/testing/bun";
import { nextTick, ref } from "vue";

type Signal = { readonly kind: string; readonly failure?: { readonly kind: string } };

const signals: Signal[] = [];
const daemonUrl = ref<string | undefined>(`https://daemon.test`);
const connection = ref({ phase: `connecting`, retryDelayMs: 0 });
const activeSandboxId = ref<string | undefined>(`sb-1`);
const refresh = jest.fn(async (): Promise<void> => {});
const daemonBase = ref<string | undefined>(`https://daemon.test`);
const usingLocal = ref(false);
const demoteIfUnreachable = jest.fn(async (_sandboxId: string): Promise<boolean> => false);
// The daemon refusing the stream with a status, as its typed errors carry one.
class Refused extends Error {
    constructor(readonly status: number) {
        super(`refused (${status})`);
    }
}
// What the diagnosis last made of the sandbox: alive (its netd answering) stretches the loop's waits.
let seemsAlive = false;
const events = jest.fn(async (_input: { clientId: string }, _options: { signal: AbortSignal }): Promise<AsyncIterable<unknown>> => {
    throw new Error(`no stream scripted`);
});

jest.mock("../../../client/sandbox/useSandbox", () => ({
    useSandbox: () => ({ daemonUrl, connection, activeSandboxId, refresh }),
    signalConnection: (signal: Signal) => signals.push(signal),
}));
jest.mock("../../../client/endpoint/useEndpoint", () => ({
    useEndpoint: () => ({
        daemonBase,
        usingLocal,
        resolve: async () => undefined,
        demoteIfUnreachable,
        reset: () => undefined,
        recheckAfterWake: () => undefined,
    }),
}));
jest.mock("../../../client/sandbox/sandboxRpc", () => ({
    sandboxRpc: { system: { events } },
    daemonErrorStatus: (error: unknown) => (error instanceof Refused ? error.status : undefined),
    daemonErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
jest.mock("../../../client/sandbox/sandboxAuthFetch", () => ({ SandboxUnaddressedError: class extends Error {} }));
jest.mock("../../../client/session/sandboxSession", () => ({ useSandboxSession: () => ({ invalidateSession: () => undefined }) }));
jest.mock("../../../client/sandbox/edgeVerdict", () => ({ forgetEdgeVerdict: () => undefined, lastEdgeVerdict: () => undefined }));
jest.mock("../../../client/sandbox/pageWake", () => ({ watchPageWake: () => () => undefined, refVisibility: () => undefined }));
jest.mock("../../../app/hotReload", () => ({ reloadOnHotUpdate: () => undefined }));
jest.mock("../../../lib/queryPersistence", () => ({ queryClient: { removeQueries: () => undefined } }));
jest.mock("../../../workbench/presence/usePresence", () => ({ clearPresence: () => undefined, presenceStreamOpened: () => undefined }));
jest.mock("../../../models/fleet/useAgents", () => ({ desyncAgents: () => undefined }));
jest.mock("../live/systemEvents", () => ({ applySystemEvent: () => undefined }));
jest.mock("../live/systemEventRouting", () => ({ sandboxQueryPredicate: () => () => false }));
jest.mock("../diagnosis/useDiagnosis", () => ({ sandboxSeemsAlive: () => seemsAlive, startDiagnosis: () => undefined, stopDiagnosis: () => undefined }));

const { useSandboxLiveness } = await import("./useSandboxLiveness");
const { closeAllWakeWindows, openWakeWindow } = await import("../../../client/sandbox/wake/wakeWindow");
const { start, stop } = useSandboxLiveness();

// A connect that never answers, failing only once its signal aborts, as a cancelled fetch does.
const hangs = (signal: AbortSignal): Promise<never> =>
    new Promise((_resolve, reject) => signal.addEventListener(`abort`, () => reject(signal.reason), { once: true }));

// A stream that connected and then went quiet; when cut, it fails, or (as some transports do) just ends.
const silentStream = (signal: AbortSignal, onCut: `throws` | `ends`): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<unknown>> => {
            await (onCut === `throws` ? hangs(signal) : new Promise((resolve) => signal.addEventListener(`abort`, resolve, { once: true })));
            return { done: true, value: undefined };
        },
    }),
});

const kinds = (): string[] => signals.map((signal) => signal.kind);
const failures = (): string[] => signals.flatMap((signal) => (signal.failure === undefined ? [] : [signal.failure.kind]));

beforeEach(async () => {
    daemonUrl.value = `https://daemon.test`;
    connection.value = { phase: `connecting`, retryDelayMs: 0 };
    activeSandboxId.value = `sb-1`;
    daemonBase.value = `https://daemon.test`;
    usingLocal.value = false;
    seemsAlive = false;
    refresh.mockReset();
    refresh.mockImplementation(async () => {});
    demoteIfUnreachable.mockImplementation(async () => false);
    events.mockReset();
    events.mockImplementation(async (_input, { signal }) => hangs(signal));
    await nextTick();
    signals.length = 0;
});

afterEach(async () => {
    stop();
    closeAllWakeWindows();
    jest.useRealTimers();
    // Lets the stopped loop unwind before the next case scripts the mocks it would otherwise read.
    await new Promise((resolve) => setTimeout(resolve));
});

test(`a stop while the address is still being asked for opens no stream after it`, async () => {
    daemonUrl.value = undefined;
    let answer!: () => void;
    refresh.mockImplementation(
        () =>
            new Promise<void>((resolve) => {
                answer = () => {
                    daemonUrl.value = `https://daemon.test`;
                    resolve();
                };
            }),
    );
    start();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    stop();
    answer();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect({ streams: events.mock.calls.length, after: kinds().slice(kinds().indexOf(`disconnect`) + 1) }).toEqual({ streams: 0, after: [] });
});

test(`a stop during the backoff ends it, and a start right after runs one loop, not two`, async () => {
    jest.useFakeTimers();
    connection.value = { phase: `connecting`, retryDelayMs: 60_000 };
    events.mockImplementationOnce(async () => {
        throw new Error(`fetch failed`);
    });
    start();
    await waitFor(() => expect(failures()).toEqual([`network`]));
    expect(jest.getTimerCount()).toBe(1);

    stop();
    expect(jest.getTimerCount()).toBe(0);
    start();
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    // Past the first run's backoff, short of the second's (its watchdog's 10s, then 60s): only a loop left over from
    // the first run would dial now.
    await advanceTimersByTimeAsync(65_000);

    expect(events).toHaveBeenCalledTimes(2);
});

test(`a switch during the shortcut's probe is not reported against the box switched to, which is dialled at once`, async () => {
    connection.value = { phase: `connecting`, retryDelayMs: 60_000 };
    usingLocal.value = true;
    let answer!: (demoted: boolean) => void;
    demoteIfUnreachable.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
    events.mockImplementationOnce(async () => {
        throw new Error(`fetch failed`);
    });
    start();
    await waitFor(() => expect(demoteIfUnreachable).toHaveBeenCalledWith(`sb-1`));

    activeSandboxId.value = `sb-2`;
    await waitFor(() => expect(kinds()).toContain(`switched`));
    answer(false);

    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    expect(kinds().slice(kinds().indexOf(`switched`))).not.toContain(`failed`);
});

test(`a broken stream is classified by its own error, even when the shortcut's probe outlasts the watchdog`, async () => {
    jest.useFakeTimers();
    usingLocal.value = true;
    let answer!: (demoted: boolean) => void;
    demoteIfUnreachable.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
    events.mockImplementationOnce(async () => {
        throw new Refused(403);
    });
    start();
    await waitFor(() => expect(demoteIfUnreachable).toHaveBeenCalledWith(`sb-1`));

    await advanceTimersByTimeAsync(15_000);
    answer(false);

    await waitFor(() => expect(failures()).toEqual([`forbidden`]));
});

test.each([`throws`, `ends`] as const)(`a stream silent past the watchdog is cut and reported as a timeout when the cut %s`, async (onCut) => {
    jest.useFakeTimers();
    let cut: AbortSignal | undefined;
    events.mockImplementationOnce(async (_input, { signal }) => {
        cut = signal;
        return silentStream(signal, onCut);
    });
    start();
    await waitFor(() => expect(kinds()).toContain(`opened`));

    await advanceTimersByTimeAsync(10_000);

    await waitFor(() => expect({ failures: failures(), cut: cut?.aborted }).toEqual({ failures: [`timeout`], cut: true }));
});

// A wake this browser asked for puts the sandbox back within seconds, and until then every attempt is answered at once
// (the edge's 502, netd's 503), so the loop redials each second instead of waiting out its rung, busy or not, and asks
// the platform for the list at most every five seconds. Outside a wake, the rung (here the 5 s ceiling, stretched to
// 10 s for a sandbox that seems alive) and a list on every break, as before. Each case dials its own sandbox, so the
// list one case asked for is not the one the next measures from.
test.each([
    [`a pending wake`, true, false, { dials: 10, lists: 2 }],
    [`a pending wake on a sandbox that seems alive`, true, true, { dials: 10, lists: 2 }],
    [`no wake`, false, false, { dials: 2, lists: 2 }],
    [`no wake on a sandbox that seems alive`, false, true, { dials: 1, lists: 1 }],
] as const)(`over 9.5 s of failures with %s, the loop dials and lists as the wake allows`, async (_name, waking, alive, expected) => {
    jest.useFakeTimers();
    const sandboxId = `sb-waking-${String(waking)}-${String(alive)}`;
    activeSandboxId.value = sandboxId;
    await nextTick();
    connection.value = { phase: `retrying`, retryDelayMs: 5_000 };
    seemsAlive = alive;
    if (waking) {
        openWakeWindow(sandboxId, Date.now());
    }
    events.mockImplementation(async () => {
        throw new Error(`fetch failed`);
    });
    start();
    await waitFor(() => expect(events).toHaveBeenCalledTimes(1));

    await advanceTimersByTimeAsync(9_500);

    expect({ dials: events.mock.calls.length, lists: refresh.mock.calls.length }).toEqual(expected);
});

test(`the loop goes back to its rung once the waking window has passed`, async () => {
    jest.useFakeTimers();
    activeSandboxId.value = `sb-waking-lapses`;
    await nextTick();
    connection.value = { phase: `retrying`, retryDelayMs: 5_000 };
    // Asked long enough ago that the window has two seconds left.
    openWakeWindow(`sb-waking-lapses`, Date.now() - (3 * 60_000 - 2_000));
    events.mockImplementation(async () => {
        throw new Error(`fetch failed`);
    });
    start();
    await waitFor(() => expect(events).toHaveBeenCalledTimes(1));

    await advanceTimersByTimeAsync(9_500);

    // At 0, 1 and 2 s inside the window; the wait after the third is the rung's 5 s, so the fourth is at 7 s.
    expect(events).toHaveBeenCalledTimes(4);
});
