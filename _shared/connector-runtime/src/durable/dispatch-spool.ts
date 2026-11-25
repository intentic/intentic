import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import { pathExists, readTextIfExists, writeFileAtomic } from "@intentic/base/fs";
import { parseJsonWith } from "@intentic/base/json";
import { type ListenerMessage, ListenerMessageSchema } from "@intentic/sandbox-contract/listener-protocol";
import type { DaemonClient, DispatchOptions } from "../daemon.js";
import type { Logger } from "../log.js";

// The gateway's own durable copy of what it heard, kept until the daemon admits it. A gateway hears a message once:
// Slack is told it arrived, Telegram's offset moves past it, Discord and WhatsApp never send it again. So a message is
// written here before the daemon is asked, one file per message under the extension's state directory, and a message
// the daemon could not take (restarting, updating, wedged) is retried with backoff until it does, across a gateway
// restart too. A file leaves once the daemon has the message: its plain dispatch answered 200, or its stream's status
// arrived, which today's daemon sends only after its inbox write. Each message carries one key on every try (the
// contract's LISTENER_DISPATCH_KEY_HEADER), so the daemon admits a retry of one it already took once. The key is the
// message's own identity, so a platform redelivering a message this gateway already keeps is not kept, or sent, twice.
// A streamed message (one we answer live) is retried in place while its reply waits; past STREAM_PATIENCE_MS the reply
// gives up and the spool replays the message plain with `answer: "channel"`, which today's daemon answers into the
// thread (an older one wakes the automation without a stream, and the agent answers as it would any message).

// How long a live reply waits for a daemon that is down before the spool takes the message over.
const STREAM_PATIENCE_MS = 2 * 60 * 1000;
// How long a kept message is retried before it is given up: past this, an answer would arrive as a stray.
export const SPOOL_TTL_MS = 24 * 60 * 60 * 1000;
// Messages kept at once; past it the oldest go, so a daemon gone for good cannot fill the disk.
const SPOOL_MAX = 1_000;
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 60_000;

// The wait before the next try after `failures` in a row, from `first`, doubling, at most a minute.
const retryAfter = (failures: number, first: number = RETRY_FIRST_MS): number => Math.min(RETRY_MAX_MS, first * 2 ** Math.max(0, failures - 1));

// One kept message: its key, when it was kept, and whether it was heard as one we answer live (replayed, it asks to be
// answered in its channel). The file holds the message; the name says the rest, so nothing but the contract parses it.
export interface Spooled {
    readonly key: string;
    readonly at: number;
    readonly streamed: boolean;
    readonly message: ListenerMessage;
}

const PLAIN = ".json";
const STREAMED = ".stream.json";

// The message's identity, the same however often the platform delivers it; a message with no id of its own gets a
// fresh key, which still dedupes its own retries.
export const spoolKeyOf = (message: ListenerMessage): string =>
    message.id === ""
        ? randomUUID()
        : createHash("sha256")
              .update(JSON.stringify([message.provider, message.type, message.channelId, message.thread ?? "", message.id, message.timestamp]))
              .digest("hex")
              .slice(0, 40);

// The spool's files: written whole and renamed into place, so a crash mid-write leaves no half message to replay.
const spoolFiles = (dir: string, log: Logger) => {
    const fileOf = (key: string, streamed: boolean): string => join(dir, `${key}${streamed ? STREAMED : PLAIN}`);
    return {
        has: async (key: string): Promise<boolean> => (await pathExists(fileOf(key, false))) || pathExists(fileOf(key, true)),
        keep: async (key: string, streamed: boolean, message: ListenerMessage): Promise<boolean> => {
            try {
                await mkdir(dir, { recursive: true });
                await writeFileAtomic(fileOf(key, streamed), JSON.stringify(message));
                return true;
            } catch (error) {
                log.error({ err: error, key }, "dispatch spool: the message could not be kept, so it is tried once");
                return false;
            }
        },
        drop: async (key: string): Promise<void> => {
            await Promise.all([rm(fileOf(key, false), { force: true }), rm(fileOf(key, true), { force: true })]).catch((error: Error) =>
                log.warn({ err: error, key }, "dispatch spool: an admitted message's file could not be removed"),
            );
        },
        // What is kept, oldest first; a file that does not hold a message is dropped and said.
        list: async (): Promise<Spooled[]> => {
            // No directory yet is nothing kept yet.
            const names = (await pathExists(dir)) ? await readdir(dir) : [];
            const entries: Spooled[] = [];
            for (const name of names.filter((each) => each.endsWith(PLAIN) && !each.startsWith("."))) {
                const path = join(dir, name);
                const raw = await readTextIfExists(path);
                // Gone meanwhile: another try took it.
                if (raw === undefined) {
                    continue;
                }
                const message = parseJsonWith(raw, ListenerMessageSchema);
                if (message === undefined) {
                    log.error({ file: name }, "dispatch spool: a kept message could not be read, and is dropped");
                    await rm(path, { force: true });
                    continue;
                }
                const info = await stat(path);
                const streamed = name.endsWith(STREAMED);
                entries.push({ key: name.slice(0, -(streamed ? STREAMED : PLAIN).length), at: info.mtimeMs, streamed, message });
            }
            return entries.toSorted((a, b) => a.at - b.at);
        },
    };
};
type SpoolFiles = ReturnType<typeof spoolFiles>;

// One pass over what is kept, oldest first, stopping at the first failure (the daemon is down for all of them): whether
// it got through everything. Keys being worked on elsewhere are left alone.
const retryPass = async <TConfig>(daemon: DaemonClient<TConfig>, files: SpoolFiles, active: Set<string>, log: Logger): Promise<boolean> => {
    const entries = await files.list();
    const over = Math.max(0, entries.length - SPOOL_MAX);
    for (const [index, entry] of entries.entries()) {
        if (active.has(entry.key)) {
            continue;
        }
        if (index < over || Date.now() - entry.at > SPOOL_TTL_MS) {
            const { provider, type, channelId } = entry.message;
            log.error(
                { key: entry.key, provider, type, channelId, keptFor: Date.now() - entry.at },
                index < over ? `dispatch spool: more than ${SPOOL_MAX} messages kept, the oldest is given up` : "dispatch spool: the daemon never took this message within a day; given up",
            );
            await files.drop(entry.key);
            continue;
        }
        active.add(entry.key);
        try {
            await daemon.dispatch(entry.message, { key: entry.key, answer: entry.streamed ? "channel" : undefined });
            await files.drop(entry.key);
        } catch (error) {
            log.warn({ err: error, kept: entries.length }, "dispatch spool: the daemon did not take a kept message; trying again later");
            return false;
        } finally {
            active.delete(entry.key);
        }
    }
    return true;
};

// The retry loop: one pass at a time, a call during one running one more after it, then again on a backoff that grows
// while the daemon stays down.
const retryLoop = (pass: () => Promise<boolean>, first: number, log: Logger): (() => Promise<void>) => {
    let passing: Promise<void> | undefined;
    let again = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const replay = (): Promise<void> => {
        if (passing !== undefined) {
            again = true;
            return passing;
        }
        clearTimeout(timer);
        timer = undefined;
        passing = (async () => {
            let clean = true;
            do {
                again = false;
                clean = await pass().catch((error: Error) => {
                    log.error({ err: error }, "dispatch spool: a retry pass failed");
                    return false;
                });
            } while (again && clean);
            passing = undefined;
            failures = clean ? 0 : failures + 1;
            if (!clean) {
                timer = setTimeout(() => void replay(), retryAfter(failures, first));
                timer.unref();
            }
        })();
        return passing;
    };
    return replay;
};

export interface SpoolOptions {
    readonly dir: string;
    readonly log: Logger;
    readonly streamPatienceMs?: number;
    readonly retryFirstMs?: number;
}

export interface DispatchSpool {
    // Tries everything kept now (at start, what an earlier process left), and keeps trying until nothing is.
    readonly replay: () => Promise<void>;
    // What is kept and not yet admitted, oldest first.
    readonly kept: () => Promise<Spooled[]>;
}

// The daemon client with dispatch and dispatchStreaming going through the spool; every other call is the client's own.
export const spoolDispatches = <TConfig>(daemon: DaemonClient<TConfig>, options: SpoolOptions): DaemonClient<TConfig> & DispatchSpool => {
    const { log } = options;
    const first = options.retryFirstMs ?? RETRY_FIRST_MS;
    const files = spoolFiles(options.dir, log);
    // Keys a dispatch or a retry is working on now: the retry pass leaves them alone, and a redelivery is a duplicate.
    const active = new Set<string>();
    const replay = retryLoop(() => retryPass(daemon, files, active, log), first, log);
    const later = (): void => void Promise.resolve().then(replay);

    // Starts a message's life in the spool: undefined for a duplicate of one already kept or in hand (the caller only
    // says it is kept), else whether it is on disk now. Either way the caller is told once it is safe.
    const begin = async (key: string, streamed: boolean, message: ListenerMessage, given: DispatchOptions): Promise<boolean | undefined> => {
        if (active.has(key) || (await files.has(key))) {
            given.onKept?.();
            return undefined;
        }
        active.add(key);
        const onDisk = await files.keep(key, streamed, message);
        if (onDisk) {
            given.onKept?.();
        }
        return onDisk;
    };

    const dispatch: DaemonClient<TConfig>["dispatch"] = async (message, given = {}) => {
        const key = spoolKeyOf(message);
        const onDisk = await begin(key, false, message, given);
        if (onDisk === undefined) {
            return;
        }
        try {
            await daemon.dispatch(message, { key, answer: given.answer, onKept: onDisk ? undefined : given.onKept });
            await files.drop(key);
        } catch (error) {
            if (!onDisk) {
                throw error;
            }
            log.warn({ err: error, key }, "dispatch spool: the daemon did not take the message; it is kept and retried");
            later();
        } finally {
            active.delete(key);
        }
    };

    const dispatchStreaming: DaemonClient<TConfig>["dispatchStreaming"] = async (message, onFrame, given = {}) => {
        const key = spoolKeyOf(message);
        const onDisk = await begin(key, true, message, given);
        if (onDisk === undefined) {
            return;
        }
        const deadline = Date.now() + (options.streamPatienceMs ?? STREAM_PATIENCE_MS);
        try {
            for (let tries = 1; ; tries += 1) {
                let admitted = false;
                const onKept = (): void => {
                    admitted = true;
                    void files.drop(key);
                    if (!onDisk) {
                        given.onKept?.();
                    }
                };
                try {
                    await daemon.dispatchStreaming(message, onFrame, { key, onKept });
                    return;
                } catch (error) {
                    // Admitted, the daemon's own inbox and journal answer for the message now; and with no copy of our
                    // own there is nothing to retry from.
                    if (admitted || !onDisk) {
                        throw error;
                    }
                    if (Date.now() + retryAfter(tries, first) > deadline) {
                        log.warn({ err: error, key }, "dispatch spool: the daemon stayed down past a live reply's patience; the message is kept and answered in its thread");
                        later();
                        throw error;
                    }
                    log.warn({ err: error, key, tries }, "dispatch spool: the daemon did not take a message being answered live; trying again");
                    await sleep(retryAfter(tries, first));
                }
            }
        } finally {
            active.delete(key);
        }
    };

    return { ...daemon, dispatch, dispatchStreaming, replay, kept: files.list };
};
