import { STATE_DIR } from "@intentic/constants";
import type { IntenticApi } from "@intentic/extension-api";
import { resetSandboxScope, sandboxLedger, sandboxPoll } from "@intentic/extension-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* The background pair (extension-api/src/background.ts), tested from here because the SDK ships no test harness
 * of its own: the same reason scope.test.ts and surface-guard.test.ts live in this directory.
 *
 * What is under test is the set of rules seven hand-written copies of this had to remember, and six of them got
 * one of wrong. Each rule below is invisible in the code that breaks it: the tile simply says something untrue,
 * or the console fills with unhandled rejections, or a file lands in the wrong workspace. */

const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

/* The smallest api a poll or a ledger touches. `reachable` is a field so a test can take the daemon away.
 *
 * `onDidChangeFiles` is present only when a test asks for it (`watching: true`), which is deliberate: an older
 * host does not have it, and every test that leaves it out is therefore also checking that a poll on such a host
 * still runs on its timer instead of failing to start. */
const fakeApi = (over: { reachable?: boolean; file?: unknown; watching?: boolean; write?: (path: string, body: string) => void } = {}) => {
    const written: { path: string; body: string }[] = [];
    const listeners = new Set<(paths: readonly string[]) => void>();
    const api = {
        sandbox: { reachable: () => over.reachable !== false },
        workspace: {
            readJson: () => Promise.resolve(over.file),
            write: (path: string, body: string) => {
                written.push({ path, body });
                over.write?.(path, body);
                return Promise.resolve();
            },
            ...(over.watching === true
                ? {
                      onDidChangeFiles: (listener: (paths: readonly string[]) => void) => {
                          listeners.add(listener);
                          return { dispose: () => void listeners.delete(listener) };
                      },
                  }
                : {}),
        },
    } as unknown as IntenticApi;
    // What the host does when the daemon reports a write under one of this extension's declared paths.
    const writeLanded = (paths: readonly string[] = [`${STATE_DIR}/config/drafts/one.json`]): void => {
        for (const listener of listeners) {
            listener(paths);
        }
    };
    return { api, written, writeLanded, watchers: () => listeners.size };
};

beforeEach(() => {
    resetSandboxScope();
    vi.useRealTimers();
});

describe(`sandboxPoll`, () => {
    it(`reads once on start and then on the interval, and stops when disposed`, async () => {
        vi.useFakeTimers();
        const { api } = fakeApi();
        const read = vi.fn(async () => `answer`);
        const poll = sandboxPoll({ host: () => api, everyMs: 1_000, initial: () => ``, read });

        const running = poll.start();
        await flush();
        expect(read).toHaveBeenCalledTimes(1);
        expect(poll.state.value).toBe(`answer`);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(read).toHaveBeenCalledTimes(3);

        running.dispose();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(read).toHaveBeenCalledTimes(3);
    });

    it(`skips the opening read when the caller has nothing to ask yet`, async () => {
        const { api } = fakeApi();
        const read = vi.fn(async () => `answer`);
        const poll = sandboxPoll({ host: () => api, everyMs: 60_000, immediate: false, initial: () => ``, read });

        poll.start().dispose();
        await flush();

        expect(read).not.toHaveBeenCalled();
    });

    it(`asks nothing of an unreachable daemon`, async () => {
        const { api } = fakeApi({ reachable: false });
        const read = vi.fn(async () => `answer`);
        const poll = sandboxPoll({ host: () => api, everyMs: 60_000, initial: () => ``, read });

        poll.refresh();
        await flush();

        expect(read).not.toHaveBeenCalled();
    });

    /* The rule that makes this safe to call from module scope: `host()` throws until activate() binds one, and
     * this runs detached on a timer, so a throw here is an unhandled rejection in the console of an app that is
     * otherwise fine. */
    it(`survives a host that is not bound yet`, async () => {
        const poll = sandboxPoll({
            host: () => {
                throw new Error(`host() called before activate()`);
            },
            everyMs: 60_000,
            initial: () => `initial`,
            read: async () => `answer`,
        });

        poll.refresh();
        await flush();

        expect(poll.state.value).toBe(`initial`);
    });

    it(`keeps the last good answer when a read fails: "we could not ask" is not "there is nothing there"`, async () => {
        const { api } = fakeApi();
        let fail = false;
        const poll = sandboxPoll({
            host: () => api,
            everyMs: 60_000,
            initial: () => ``,
            read: async () => {
                if (fail) {
                    throw new Error(`daemon refused`);
                }
                return `answer`;
            },
        });

        poll.refresh();
        await flush();
        fail = true;
        poll.refresh();
        await flush();

        expect(poll.state.value).toBe(`answer`);
    });

    // The reported bug's shape, at the primitive: an answer for the box the reader has left must not become the
    // box they are on.
    it(`drops an answer that arrives after a sandbox switch`, async () => {
        const { api } = fakeApi();
        let answer = (): void => {};
        const poll = sandboxPoll({
            host: () => api,
            everyMs: 60_000,
            initial: () => `initial`,
            read: async () =>
                new Promise<string>((resolve) => {
                    answer = () => resolve(`the box we just left`);
                }),
        });

        poll.refresh();
        await flush();
        resetSandboxScope();
        answer();
        await flush();

        expect(poll.state.value).toBe(`initial`);
    });

    it(`hands the read what it already holds, for a poll that accumulates`, async () => {
        const { api } = fakeApi();
        const poll = sandboxPoll<string[]>({
            host: () => api,
            everyMs: 60_000,
            initial: () => [],
            read: async (_api, previous) => [...previous, `round`],
        });

        poll.refresh();
        await flush();
        poll.refresh();
        await flush();

        expect(poll.state.value).toEqual([`round`, `round`]);
    });

    /* THE BUG THIS PAIR WAS SUPPOSED TO PREVENT AND DID NOT: the badge said six after the queue was emptied.
     * Every input to a drafts count is a write under a path the manifest declares, and the host was already
     * pushing that write, so a whole minute of a wrong number was a minute nobody had to pay for. */
    it(`re-reads when one of the extension's declared files is written, without waiting out the interval`, async () => {
        vi.useFakeTimers();
        const { api, writeLanded } = fakeApi({ watching: true });
        const read = vi.fn(async () => `answer`);
        const poll = sandboxPoll({ host: () => api, everyMs: 600_000, initial: () => ``, read });

        const running = poll.start();
        await flush();
        expect(read).toHaveBeenCalledTimes(1);

        writeLanded();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(read).toHaveBeenCalledTimes(2);

        running.dispose();
    });

    // A run writing a result file per story, a publish rewriting a staging tree: one logical event, many frames.
    // The widest badge scan in the workspace must not be re-run per frame.
    it(`coalesces a burst of writes into one read`, async () => {
        vi.useFakeTimers();
        const { api, writeLanded } = fakeApi({ watching: true });
        const read = vi.fn(async () => `answer`);
        const poll = sandboxPoll({ host: () => api, everyMs: 600_000, immediate: false, initial: () => ``, read });

        const running = poll.start();
        for (let frame = 0; frame < 5; frame++) {
            writeLanded();
            await vi.advanceTimersByTimeAsync(50);
        }
        await vi.advanceTimersByTimeAsync(1_000);

        expect(read).toHaveBeenCalledTimes(1);
        running.dispose();
    });

    it(`stops listening for writes when the extension is disposed`, async () => {
        vi.useFakeTimers();
        const { api, writeLanded, watchers } = fakeApi({ watching: true });
        const read = vi.fn(async () => `answer`);
        const poll = sandboxPoll({ host: () => api, everyMs: 600_000, immediate: false, initial: () => ``, read });

        poll.start().dispose();
        expect(watchers()).toBe(0);
        writeLanded();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(read).not.toHaveBeenCalled();
    });

    /* An extension may declare `engines.intentic` wider than the release that added the channel, so the SDK can
     * find itself on a host without it. A slower badge is the right degradation; a poll that fails to start is
     * not, and that is what an uncaught call on `undefined` inside start() would be. */
    it(`still runs on its timer on a host that cannot announce file writes`, async () => {
        vi.useFakeTimers();
        const { api } = fakeApi();
        const read = vi.fn(async () => `answer`);
        const poll = sandboxPoll({ host: () => api, everyMs: 1_000, immediate: false, initial: () => ``, read });

        const running = poll.start();
        await vi.advanceTimersByTimeAsync(2_500);

        expect(read).toHaveBeenCalledTimes(2);
        running.dispose();
    });

    it(`empties on a sandbox switch, because its state is a sandboxRef`, async () => {
        const { api } = fakeApi();
        const poll = sandboxPoll({ host: () => api, everyMs: 60_000, initial: () => ``, read: async () => `answer` });

        poll.refresh();
        await flush();
        resetSandboxScope();

        expect(poll.state.value).toBe(``);
    });
});

describe(`sandboxLedger`, () => {
    it(`reads an absent file as nothing acknowledged`, async () => {
        const { api } = fakeApi({ file: undefined });

        expect(await sandboxLedger(() => api, `seen.json`).read()).toEqual({});
    });

    /* The safe direction, and the reason it is the safe one: bad bookkeeping may light a badge that should have
     * been quiet, and must never hide one that should have been lit. */
    it(`drops entries that are not marks rather than trusting them`, async () => {
        const { api } = fakeApi({ file: { good: `digest`, count: 7, nested: { a: 1 }, missing: null } });

        expect(await sandboxLedger(() => api, `seen.json`).read()).toEqual({ good: `digest` });
    });

    it(`marks entries in beside what is already there`, async () => {
        const { api, written } = fakeApi({ file: { first: `one` } });

        await sandboxLedger(() => api, `seen.json`).mark({ second: `two` });

        expect(JSON.parse(written[0]?.body ?? `{}`)).toEqual({ first: `one`, second: `two` });
    });

    it(`replaces the whole ledger when asked, so keys that went out of scope drop out`, async () => {
        const { api, written } = fakeApi({ file: { old: `run`, kept: `run` } });

        await sandboxLedger(() => api, `seen.json`).replace({ kept: `run` });

        expect(JSON.parse(written[0]?.body ?? `{}`)).toEqual({ kept: `run` });
    });

    /* No write when nothing moved. The daemon pushes a workspace write to every connected browser as a change,
     * so a ledger that rewrote itself on every open would cost all of them a refetch for identical content. */
    it(`writes nothing when the mark is already recorded`, async () => {
        const { api, written } = fakeApi({ file: { first: `one` } });

        await sandboxLedger(() => api, `seen.json`).mark({ first: `one` });

        expect(written).toEqual([]);
    });

    it(`writes nothing when a replace names exactly what is already there`, async () => {
        const { api, written } = fakeApi({ file: { first: `one` } });

        await sandboxLedger(() => api, `seen.json`).replace({ first: `one` });

        expect(written).toEqual([]);
    });

    /* The one place in an extension's background work that damages state on DISK across a switch: reading one
     * workspace's acknowledgements and writing them into the tree of the workspace the owner has moved to. */
    it(`says whether the acknowledgement landed, which is what the caller's local fold depends on`, async () => {
        const { api } = fakeApi({ file: { first: `one` } });
        const ledger = sandboxLedger(() => api, `seen.json`);

        // Written, and already-saying-it, both count as landed: the badge fold is right in either case.
        expect(await ledger.mark({ second: `two` })).toBe(true);
        expect(await ledger.mark({ first: `one` })).toBe(true);
    });

    it(`does not write into the workspace the owner switched to mid-operation`, async () => {
        let release = (): void => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const written: string[] = [];
        const api = {
            sandbox: { reachable: () => true },
            workspace: {
                readJson: async () => {
                    await held;
                    return {};
                },
                write: (path: string) => {
                    written.push(path);
                    return Promise.resolve();
                },
            },
        } as unknown as IntenticApi;

        const marking = sandboxLedger(() => api, `seen.json`).mark({ first: `one` });
        resetSandboxScope();
        release();

        // …and says so, so the caller does not clear a badge that now belongs to a different workspace.
        expect(await marking).toBe(false);
        expect(written).toEqual([]);
    });
});
