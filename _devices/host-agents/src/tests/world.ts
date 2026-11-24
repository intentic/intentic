import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AttachFrame, AttachFrameSchema } from "@intentic/sandbox-contract/events/agent-events";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { applyTranscriptPatch } from "@intentic/sandbox-contract/transcript-fold";
import { createHostAgents, type HostAgents } from "../host-agents.js";
import type { HarnessSpec } from "../harnesses.js";
import { nativePlace, type PlaceHost } from "../place.js";
import type { HostFolder } from "../state.js";

// A computer for one test: a home for the conversations, a folder a window shows, and one harness, the fake one
// (__fixtures__/fake-harness.ts), started as a real process the way an installed harness is.

const FAKE = join(import.meta.dir, `..`, `__fixtures__`, `fake-harness.ts`);

// The fake harness as a spec: found "on PATH" by the test's own place, which names this runtime for it.
export const fakeHarness = (...flags: string[]): HarnessSpec => ({
    id: `claude`,
    label: `Fake Code`,
    native: true,
    cli: { bin: `fake-harness`, args: [`--conditions=@intentic/src`, FAKE, ...flags] },
});

export interface World {
    readonly agents: HostAgents;
    readonly folder: HostFolder;
    readonly home: string;
    readonly accept: (on: boolean) => void;
    // The app quit and started again: every turn and harness process ended, and a new process reads the same home.
    readonly restarted: () => HostAgents;
    readonly dispose: () => Promise<void>;
}

export const world = async (harness: HarnessSpec = fakeHarness(), installed = true): Promise<World> => {
    const home = await mkdtemp(join(tmpdir(), `host-agents-home-`));
    const root = await realpath(await mkdtemp(join(tmpdir(), `host-agents-folder-`)));
    const native = nativePlace();
    const host: PlaceHost = { ...native, which: (bin) => Promise.resolve(bin === `fake-harness` && installed ? process.execPath : undefined) };
    let accepted = true;
    const started = (): HostAgents =>
        createHostAgents({
            home,
            log: (line) => (process.env[`HOST_AGENTS_TEST_LOG`] === undefined ? undefined : console.error(line)),
            accepted: () => accepted,
            harnesses: [harness],
            hostFor: () => host,
        });
    let agents = started();
    return {
        get agents() {
            return agents;
        },
        restarted: () => {
            agents.close();
            agents = started();
            return agents;
        },
        folder: { root, place: { kind: `native` } },
        home,
        accept: (on) => {
            accepted = on;
        },
        dispose: async () => {
            agents.close();
            await rm(home, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        },
    };
};

export const CALL = { signal: new AbortController().signal, url: new URL(`http://127.0.0.1/`) };

// What a window watching a turn ends up holding: the rows as the patches left them, every fact, and whether it ended.
export interface Watched {
    readonly run: string | undefined;
    readonly rows: readonly TranscriptRow[];
    readonly facts: readonly Extract<AttachFrame, { kind: `fact` }>[`fact`][];
    readonly ended: boolean;
}

/** Watches a conversation's run until it ends, or until `until` answers true for what has arrived. */
export const watch = (agents: HostAgents, folder: HostFolder, conversationId: string, until?: (watched: Watched) => boolean): Promise<Watched> =>
    new Promise((resolve, reject) => {
        let run: string | undefined;
        let rows: TranscriptRow[] = [];
        const facts: Extract<AttachFrame, { kind: `fact` }>[`fact`][] = [];
        let closed = false;
        const state = (ended: boolean): Watched => ({ run, rows, facts, ended });
        const take = (frame: AttachFrame): void => {
            if (frame.kind === `attached`) {
                ({ run } = frame);
                rows = [...frame.rows];
            } else if (frame.kind === `patch`) {
                rows = applyTranscriptPatch(rows, frame.patch);
            } else if (frame.kind === `fact`) {
                facts.push(frame.fact);
            } else {
                resolve(state(true));
                return;
            }
            if (until?.(state(false)) === true) {
                resolve(state(false));
            }
        };
        const { attach } = agents.proceduresFor(folder).agent;
        if (attach === undefined) {
            reject(new Error(`no attach`));
            return;
        }
        void Promise.resolve(attach({ conversationId }, CALL)).then((frames) => {
            frames.start({
                // The frames a handler answers are the contract's own: read through its schema, as a window does.
                emit: (frame) => take(AttachFrameSchema.parse(frame)),
                close: () => {
                    closed = true;
                },
                get closed() {
                    return closed;
                },
            });
        }, reject);
    });

/** Everything the assistant said in a set of rows, joined. */
export const said = (rows: readonly TranscriptRow[]): string =>
    rows
        .filter((row) => row.role === `assistant` && row.text !== ``)
        .map((row) => row.text)
        .join(`\n`);
