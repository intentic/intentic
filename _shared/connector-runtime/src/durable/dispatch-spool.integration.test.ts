import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import type { ListenerDispatchFrame, ListenerMessage } from "@intentic/sandbox-contract/listener-protocol";
import type { DaemonClient, DispatchOptions } from "../daemon.js";
import { SPOOL_TTL_MS, spoolDispatches, spoolKeyOf } from "./dispatch-spool.js";
import type { Logger } from "../log.js";

// The gateway's spool: what it heard is on disk before the daemon is asked, and stays there, retried, until the daemon
// admits it; a platform's redelivery of a message already kept is not sent twice.

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const message = (id = "m1"): ListenerMessage => ({
    provider: "slack",
    type: "message",
    id,
    channelId: "C1",
    author: { id: "U1", name: "Ada" },
    content: "deploy is failing",
    timestamp: "2026-11-24T10:00:00.000Z",
});

interface Sent {
    readonly id: string;
    readonly options: DispatchOptions;
}

// A daemon that is down until `up` says otherwise, recording every dispatch it was asked for.
const daemonWith = (frames: readonly ListenerDispatchFrame[] = [{ automationId: "a1", end: true }]) => {
    let up = false;
    const sent: Sent[] = [];
    const refuse = (): Error => new Error("connect ECONNREFUSED 127.0.0.1:1");
    const daemon = unstubbed<DaemonClient<never>>("daemon", {
        dispatch: async (received, options = {}) => {
            sent.push({ id: received.id, options });
            if (!up) {
                throw refuse();
            }
            options.onKept?.();
        },
        dispatchStreaming: async (received, onFrame, options = {}) => {
            sent.push({ id: received.id, options });
            if (!up) {
                throw refuse();
            }
            options.onKept?.();
            for (const frame of frames) {
                onFrame(frame);
            }
        },
    });
    return {
        daemon,
        sent,
        start: () => {
            up = true;
        },
    };
};

const spoolDir = (): string => join(mkdtempSync(join(tmpdir(), "dispatch-spool-")), "spool");

test("a message the daemon admits at once is said kept once and leaves nothing on disk", async () => {
    const { daemon, sent, start } = daemonWith();
    start();
    const spool = spoolDispatches(daemon, { dir: spoolDir(), log: silent });
    let kept = 0;
    await spool.dispatch(message(), { onKept: () => (kept += 1) });
    expect(kept).toBe(1);
    expect(sent).toMatchObject([{ id: "m1", options: { key: spoolKeyOf(message()) } }]);
    expect(await spool.kept()).toEqual([]);
});

test("a message the daemon cannot take is kept, said safe, and admitted under the same key once it is back", async () => {
    const { daemon, sent, start } = daemonWith();
    const spool = spoolDispatches(daemon, { dir: spoolDir(), log: silent, retryFirstMs: 60_000 });
    let kept = 0;
    // Resolves rather than throwing: the message is owed now, not lost.
    await spool.dispatch(message(), { onKept: () => (kept += 1) });
    expect(kept).toBe(1);
    expect(await spool.kept()).toMatchObject([{ streamed: false, message: { id: "m1" } }]);

    start();
    await spool.replay();
    // Every try, the first, any background retry while it was down, and the one that got through, names it alike.
    expect(new Set(sent.map((each) => each.options.key))).toEqual(new Set([spoolKeyOf(message())]));
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(await spool.kept()).toEqual([]);
});

test("a platform's redelivery of a message already kept is not kept or sent again", async () => {
    const { daemon, sent } = daemonWith();
    const spool = spoolDispatches(daemon, { dir: spoolDir(), log: silent, retryFirstMs: 60_000 });
    await spool.dispatch(message());
    let kept = 0;
    await spool.dispatch(message(), { onKept: () => (kept += 1) });
    expect(kept).toBe(1);
    // The one try is the first delivery's; the background retry has nothing new to send for the second.
    await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(1));
    expect(new Set(sent.map((each) => each.options.key))).toEqual(new Set([spoolKeyOf(message())]));
    expect(await spool.kept()).toHaveLength(1);
});

test("what a gateway kept before it restarted is sent by the next one, oldest first", async () => {
    const dir = spoolDir();
    const before = daemonWith();
    const first = spoolDispatches(before.daemon, { dir, log: silent, retryFirstMs: 60_000 });
    await first.dispatch(message("older"));
    await first.dispatch(message("newer"));

    const after = daemonWith();
    after.start();
    await spoolDispatches(after.daemon, { dir, log: silent }).replay();
    expect(after.sent.map((each) => each.id)).toEqual(["older", "newer"]);
});

test("a live answer waits out a short outage: the stream is retried in place and nothing is left kept", async () => {
    const { daemon, sent, start } = daemonWith([{ automationId: "a1", delta: "hi" }]);
    const spool = spoolDispatches(daemon, { dir: spoolDir(), log: silent, retryFirstMs: 5 });
    const frames: ListenerDispatchFrame[] = [];
    let kept = 0;
    const answering = spool.dispatchStreaming(message(), (frame) => frames.push(frame), { onKept: () => (kept += 1) });
    await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(1));
    start();
    await answering;
    expect(frames).toEqual([{ automationId: "a1", delta: "hi" }]);
    expect(kept).toBe(1);
    expect(sent.at(-1)?.options.key).toBe(spoolKeyOf(message()));
    expect(await spool.kept()).toEqual([]);
});

test("past a live answer's patience the message stays kept and is replayed to be answered in its thread", async () => {
    const { daemon, sent, start } = daemonWith();
    const spool = spoolDispatches(daemon, { dir: spoolDir(), log: silent, retryFirstMs: 60_000, streamPatienceMs: 0 });
    await expect(spool.dispatchStreaming(message(), () => {})).rejects.toThrow("ECONNREFUSED");
    expect(await spool.kept()).toMatchObject([{ streamed: true }]);
    start();
    await spool.replay();
    expect(sent.at(-1)?.options).toMatchObject({ key: spoolKeyOf(message()), answer: "channel" });
    expect(await spool.kept()).toEqual([]);
});

test("a stream that breaks after the daemon admitted the message is not sent again: the daemon answers for it now", async () => {
    let tries = 0;
    const daemon = unstubbed<DaemonClient<never>>("daemon", {
        dispatchStreaming: async (_received, _onFrame, options = {}) => {
            tries += 1;
            options.onKept?.();
            throw new Error("socket hang up");
        },
    });
    const spool = spoolDispatches(daemon, { dir: spoolDir(), log: silent, retryFirstMs: 5 });
    await expect(spool.dispatchStreaming(message(), () => {})).rejects.toThrow("socket hang up");
    expect(tries).toBe(1);
    await waitFor(async () => expect(await spool.kept()).toEqual([]));
});

test("with nowhere to keep it, a message is tried once and its failure is the caller's, as before the spool", async () => {
    const { daemon } = daemonWith();
    const blocked = join(mkdtempSync(join(tmpdir(), "dispatch-spool-")), "file");
    writeFileSync(blocked, "not a directory");
    const spool = spoolDispatches(daemon, { dir: blocked, log: silent });
    let kept = 0;
    await expect(spool.dispatch(message(), { onKept: () => (kept += 1) })).rejects.toThrow("ECONNREFUSED");
    expect(kept).toBe(0);
});

test("a message kept longer than a day is given up and said, not sent", async () => {
    const dir = spoolDir();
    const { daemon, sent, start } = daemonWith();
    const errors: string[] = [];
    const log: Logger = { ...silent, error: (_fields, text) => void errors.push(text) };
    const spool = spoolDispatches(daemon, { dir, log, retryFirstMs: 60_000 });
    await spool.dispatch(message());
    const old = (Date.now() - SPOOL_TTL_MS - 60_000) / 1000;
    utimesSync(join(dir, `${spoolKeyOf(message())}.json`), old, old);
    start();
    await spool.replay();
    expect(sent).toHaveLength(1);
    expect(await spool.kept()).toEqual([]);
    expect(errors).toEqual(["dispatch spool: the daemon never took this message within a day; given up"]);
});
