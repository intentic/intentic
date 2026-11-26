import { createBackoff, sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import type { ExtensionDeclaredReach } from "@intentic/extension-manifest/permissions";
import {
    EXTENSION_EVENT_KINDS,
    EXTENSION_EVENTS_HEARTBEAT_MS,
    EXTENSION_EVENTS_KINDS_PARAM,
    ExtensionEventSchema,
    extensionEventsUrl,
    ExtensionExecResultSchema,
    extensionExecUrl,
    extensionWorkHoldUrl,
} from "@intentic/sandbox-contract/extension-protocol";
import type { Disposable } from "./disposable.js";
import type { ExecOptions, ExecResult, ExtensionServerApi, RunSettled, SandboxActivity } from "./server.js";

// What an extension's Node code hears and asks of the daemon besides its typed calls: the event stream (its settings, the
// workspace's changes and the kinds its manifest declares), work it holds in flight, and commands it runs under a
// workload class. One implementation for the backend host and every declared process (runtime.ts); each declared reach
// is refused here before anything is sent, naming the manifest field, and the daemon refuses it again when asked.

type DaemonRequest = ExtensionServerApi["daemon"]["request"];

// What a listener of each kind is handed: the names that moved for the workspace's and settings' kinds, the frame itself
// for the kinds an extension declares.
interface Heard {
    readonly files: readonly string[];
    readonly refs: readonly string[];
    readonly repos: readonly string[];
    readonly settings: readonly string[];
    readonly run: RunSettled;
    readonly activity: SandboxActivity;
}
type HeardKind = keyof Heard;
type Listener<K extends HeardKind> = (heard: Heard[K]) => void;
type Listeners = { readonly [K in HeardKind]: Set<Listener<K>> };
type Deliver = <K extends HeardKind>(kind: K, heard: Heard[K]) => void;

// How long a connection may go without a frame before it is taken for dead: three missed heartbeats.
const SILENCE_MS = EXTENSION_EVENTS_HEARTBEAT_MS * 3;

// Every complete line in `buffer`, and what is left after the last one.
const splitLines = (buffer: string) => {
    const parts = buffer.split("\n");
    const rest = parts.pop() ?? "";
    return { lines: parts.map((line) => line.trim()).filter((line) => line !== ""), rest };
};

// Hands a frame to its kind's listeners; a line this version cannot read (not JSON, or a kind a newer daemon sends) is
// skipped rather than fatal.
const deliverLine = (line: string, deliver: Deliver): void => {
    const event = parseJsonWith(line, ExtensionEventSchema);
    switch (event?.kind) {
        case undefined:
        case "heartbeat":
            return;
        case "files":
            deliver("files", event.paths);
            return;
        case "settings":
            deliver("settings", event.keys);
            return;
        case "refs":
        case "repos":
            deliver(event.kind, event.repos);
            return;
        case "run": {
            const { kind: _kind, ...run } = event;
            deliver("run", run);
            return;
        }
        case "activity":
            deliver("activity", { live: event.live });
            return;
    }
};

// Reads one ndjson answer to its end, handing each complete line on; ends when the daemon ends it, `outer` aborts, or it
// falls silent past three heartbeats.
const readStream = async (open: (signal: AbortSignal) => Promise<Response>, outer: AbortSignal, line: (text: string) => void): Promise<void> => {
    const connection = new AbortController();
    const abort = (): void => connection.abort();
    outer.addEventListener("abort", abort, { once: true });
    let silence = setTimeout(abort, SILENCE_MS);
    try {
        const response = await open(connection.signal);
        if (!response.ok || response.body === null) {
            throw new Error(`the daemon answered ${response.status}${response.ok ? "" : `: ${(await response.text()).slice(0, 300)}`}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            clearTimeout(silence);
            silence = setTimeout(abort, SILENCE_MS);
            const split = splitLines(buffer + decoder.decode(chunk.value, { stream: true }));
            buffer = split.rest;
            for (const each of split.lines) {
                line(each);
            }
        }
    } finally {
        clearTimeout(silence);
        outer.removeEventListener("abort", abort);
    }
};

interface Streaming {
    readonly open: (signal: AbortSignal) => Promise<Response>;
    readonly line: (text: string) => void;
    // Before every connection after the first, since frames may have been missed in between.
    readonly gap: () => void;
    readonly dropped: (why: string) => void;
}

// Keeps one stream open while `signal` stands, connected again with backoff whenever it ends.
const keepStreaming = async ({ open, line, gap, dropped }: Streaming, signal: AbortSignal): Promise<void> => {
    let connections = 0;
    const backoff = createBackoff({ floorMs: 1_000, capMs: 30_000, stableMs: SILENCE_MS });
    while (!signal.aborted) {
        if (connections > 0) {
            gap();
        }
        connections += 1;
        const opened = Date.now();
        try {
            await readStream(open, signal, line);
        } catch (error) {
            if (!signal.aborted) {
                dropped(errorMessage(error));
            }
        }
        if (signal.aborted) {
            return;
        }
        await sleep(backoff.next(Date.now() - opened), { signal, unref: true });
    }
};

// The extension's event stream: opened by the first listener, closed with the last, reconnected with backoff while
// anything listens. A drop means frames were missed, so a reconnect tells every listener of a workspace or settings kind
// "anything may have changed" with an empty list, which is what a reader of an empty batch already does; `activity` is
// told afresh by the new stream itself, and a `run` missed in the gap is the reader's to catch up on.
const createEventHub = (open: (signal: AbortSignal) => Promise<Response>, log: (message: string) => void) => {
    const listeners: Listeners = { files: new Set(), refs: new Set(), repos: new Set(), settings: new Set(), run: new Set(), activity: new Set() };
    let running: AbortController | undefined;
    const count = (): number => Object.values(listeners).reduce((sum, set) => sum + set.size, 0);
    // SAFETY: `listeners[kind]` holds listeners of this very kind; the mapped type cannot say so through an index.
    const setOf = <K extends HeardKind>(kind: K): Set<Listener<K>> => listeners[kind] as Set<Listener<K>>;

    const deliver: Deliver = (kind, heard) => {
        for (const listener of setOf(kind)) {
            try {
                listener(heard);
            } catch (error) {
                // A throwing listener is its own bug; the stream and every other listener carry on.
                log(`a ${kind} listener threw: ${errorMessage(error)}`);
            }
        }
    };

    const streaming: Streaming = {
        open,
        line: (text) => deliverLine(text, deliver),
        gap: () => {
            for (const kind of EXTENSION_EVENT_KINDS) {
                deliver(kind, []);
            }
        },
        dropped: (why) => log(`the event stream dropped (${why}); reconnecting`),
    };

    const subscribe = <K extends HeardKind>(kind: K, listener: Listener<K>): Disposable => {
        setOf(kind).add(listener);
        if (running === undefined) {
            running = new AbortController();
            void keepStreaming(streaming, running.signal);
        }
        return {
            dispose: () => {
                setOf(kind).delete(listener);
                if (count() === 0) {
                    running?.abort();
                    running = undefined;
                }
            },
        };
    };

    return {
        subscribe,
        close: (): void => {
            for (const set of Object.values(listeners)) {
                set.clear();
            }
            running?.abort();
            running = undefined;
        },
    };
};

// One hold (`api.work.hold`): the hold door's answer kept open, and opened again after a drop, until disposed. Holding is
// best effort by design: a daemon that refuses it is said once in the log, never thrown at the holder mid-work.
const holdWork = (request: DaemonRequest, label: string, log: (message: string) => void): Disposable => {
    const held = new AbortController();
    let told = false;
    void keepStreaming(
        {
            open: (signal) => request(extensionWorkHoldUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }), signal }),
            line: () => undefined,
            gap: () => undefined,
            dropped: (why) => {
                if (!told) {
                    told = true;
                    log(`holding "${label}" failed (${why}); trying again until it is let go`);
                }
            },
        },
        held.signal,
    );
    return { dispose: () => held.abort() };
};

const EXEC_TIMEOUT_MS = 10 * 60_000;
const EXEC_OUTPUT_BYTES = 1024 * 1024;

// One command through the exec door, its answer read by the contract's schema. JSON leaves an absent option out.
const execThrough = async (request: DaemonRequest, argv: readonly string[], options: ExecOptions): Promise<ExecResult> => {
    const body = JSON.stringify({
        argv,
        class: options.class ?? "command",
        timeoutMs: options.timeoutMs ?? EXEC_TIMEOUT_MS,
        outputBytes: options.outputBytes ?? EXEC_OUTPUT_BYTES,
        cwd: options.cwd,
        env: options.env,
        stdin: options.stdin,
        keep: options.keep,
        label: options.label,
    });
    const answered = await request(extensionExecUrl(), { method: "POST", headers: { "content-type": "application/json" }, body, signal: options.signal ?? null });
    if (!answered.ok) {
        throw new Error(`daemon answered ${answered.status} for POST ${extensionExecUrl()}: ${(await answered.text()).slice(0, 300)}`);
    }
    return ExtensionExecResultSchema.parse(await answered.json());
};

// A refusal before anything is sent, naming the manifest field that would allow it.
const undeclared = (id: string, what: string, field: string): Error => new Error(`extension "${id}" ${what}: declare it in ${field} in its manifest`);

export interface BackendReach {
    readonly onSettings: (listener: (keys: readonly string[]) => void) => Disposable;
    readonly workspace: ExtensionServerApi["workspace"];
    readonly events: ExtensionServerApi["events"];
    readonly work: ExtensionServerApi["work"];
    readonly exec: ExtensionServerApi["exec"];
    // Ends the event stream; holds belong to their holders.
    readonly close: () => void;
}

/**
 * The reach `declared` grants one extension, over `request` (its token on every call). The stream asks for every event
 * kind the manifest declares: the daemon refuses a kind it does not, and one from before them ignores the question.
 */
export const createBackendReach = (id: string, request: DaemonRequest, declared: ExtensionDeclaredReach, log: (message: string) => void): BackendReach => {
    const kinds = declared.events.length === 0 ? "" : `?${EXTENSION_EVENTS_KINDS_PARAM}=${declared.events.join(",")}`;
    const hub = createEventHub((signal) => request(`${extensionEventsUrl()}${kinds}`, { signal }), log);
    return {
        onSettings: (listener) => hub.subscribe("settings", listener),
        workspace: {
            onDidChangeFiles: (listener) => hub.subscribe("files", listener),
            onDidChangeRefs: (listener) => hub.subscribe("refs", listener),
            onDidChangeRepos: (listener) => hub.subscribe("repos", listener),
        },
        events: {
            onRunSettled: (listener) => {
                if (!declared.events.includes("run")) {
                    throw undeclared(id, "listened for its conversations' runs (`run`) without declaring it", "permissions.events");
                }
                return hub.subscribe("run", listener);
            },
            onActivity: (listener) => {
                if (!declared.events.includes("activity")) {
                    throw undeclared(id, "listened for the sandbox's activity (`activity`) without declaring it", "permissions.events");
                }
                return hub.subscribe("activity", listener);
            },
        },
        work: {
            hold: (label) => {
                if (!declared.work) {
                    throw undeclared(id, `held work ("${label}") without declaring it`, "permissions.work");
                }
                return holdWork(request, label, log);
            },
        },
        exec: async (argv, options = {}) => {
            const workload = options.class ?? "command";
            if (!declared.exec.includes(workload)) {
                throw undeclared(id, `ran a command in the ${workload} class without declaring it`, "permissions.exec");
            }
            return execThrough(request, argv, options);
        },
        close: hub.close,
    };
};
