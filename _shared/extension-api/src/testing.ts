import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionReach, extensionRouteReach } from "@intentic/extension-manifest/permissions";
import { type ExtensionEvent, extensionEventsUrl, extensionSettingsUrl } from "@intentic/sandbox-contract/extension-protocol";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/headers";
import { activateServerModule, createServerApi, deactivateWithin, healthWithin } from "./runtime.js";
import type {
    ExtensionHealth,
    ExtensionServerApi,
    ExtensionServerModule,
    ExtensionSettingValues,
    ServerActivation,
    ToolCard,
    ToolCallContext,
    ToolDefinition,
} from "./server.js";

// A backend under test, on the real backend api (runtime.ts) with only the daemon stood in for: every call the extension
// makes is judged by the same reach rule the daemon's grant applies (extension-manifest's extensionRouteReach), so a test
// that passes here does not lean on a route the manifest never declared. Its settings and event stream are the daemon's
// own routes, answered here; everything else the extension is admitted to goes to the test's `daemon` handler.
// Touches the disk (fresh temp directories for whatever the test leaves unnamed), so a suite using it is an
// `*.integration.test.ts`.

const DAEMON = "http://daemon.fake";
const TOKEN = "fake-extension-token";

// The part of a manifest the fake reads: who the extension is and how far it reaches.
export interface FakeManifest {
    readonly publisher: string;
    readonly name: string;
    readonly permissions?: { readonly daemon?: readonly string[] };
    readonly contributes?: { readonly listener?: { readonly provider: string } };
}

export interface FakeExtensionOptions {
    readonly manifest: FakeManifest;
    // Answers a daemon call the extension's reach admits. Absent, or answering undefined: 404, as for a route that is
    // not there.
    readonly daemon?: (request: Request) => Response | undefined | Promise<Response | undefined>;
    readonly settings?: ExtensionSettingValues;
    // Each a fresh temp directory when absent, removed again by `dispose`.
    readonly workspaceRoot?: string;
    readonly extensionDir?: string;
    readonly stateDir?: string;
    readonly cacheDir?: string;
}

// What a tool is called with, as ToolDefinition declares it.
type ToolArguments = Parameters<ToolDefinition["call"]>[0];

// One request the extension sent the daemon, and whether its reach admitted it.
export interface FakeDaemonCall {
    readonly line: string;
    readonly admitted: boolean;
}

export interface FakeExtension {
    readonly api: ExtensionServerApi;
    readonly calls: readonly FakeDaemonCall[];
    readonly logs: readonly string[];
    // Activates a server module as the backend host does, keeping what it hands back for `deactivate` and `health`.
    activate(module: Partial<ExtensionServerModule> & { default?: ExtensionServerModule }): Promise<void>;
    // A request into the extension's own /x namespace, `path` relative to it, as the daemon's proxy delivers it.
    route(path: string, init?: RequestInit): Promise<Response>;
    // The tools it serves a card (undefined: the extension-level server), and one call to one of them.
    tools(card?: ToolCard): Promise<readonly ToolDefinition[]>;
    // Answers whatever the tool's own `call` answers, as ToolDefinition declares it; the host turns that into what the
    // model reads.
    callTool(name: string, args?: ToolArguments, card?: ToolCard, context?: Partial<ToolCallContext>): ReturnType<ToolDefinition["call"]>;
    // The owner changing its settings: stored, and told to the extension over its event stream as the daemon would.
    setSettings(values: ExtensionSettingValues): void;
    // A frame on its event stream, as the daemon sends it (`files`, `refs`, `repos`, `settings`).
    emit(event: ExtensionEvent): void;
    // Its own account of itself, as the host reads it under the host's deadline and vocabulary.
    health(): Promise<ExtensionHealth>;
    // Its `deactivate`, under the host's deadline.
    deactivate(): Promise<void>;
    // Ends the event stream and removes every temp directory the fake made.
    dispose(): Promise<void>;
}

const json = <T>(body: T, status = 200): Response => Response.json(body, { status });

// What changed between two settings maps: every key whose value differs, either way.
const changedKeys = (before: ExtensionSettingValues, after: ExtensionSettingValues): string[] =>
    [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]).toSorted();

export const fakeExtensionApi = async (options: FakeExtensionOptions): Promise<FakeExtension> => {
    const made: string[] = [];
    const dirOf = async (given: string | undefined, label: string): Promise<string> => {
        if (given !== undefined) {
            return given;
        }
        const dir = await mkdtemp(join(tmpdir(), `fake-extension-${label}-`));
        made.push(dir);
        return dir;
    };
    const workspaceRoot = await dirOf(options.workspaceRoot, "workspace");
    const id = `${options.manifest.publisher}.${options.manifest.name}`;
    const reach: ExtensionReach = { permissions: options.manifest.permissions?.daemon ?? [], listener: options.manifest.contributes?.listener?.provider };
    const calls: FakeDaemonCall[] = [];
    const logs: string[] = [];
    let settings: ExtensionSettingValues = { ...options.settings };
    // Every event stream the extension holds open, each written to by `emit`. A frame sent while none is open waits for
    // the next one: the runtime opens its stream a moment after the first listener registers, and a test that listens
    // and then emits must not race that. The daemon itself keeps nothing for a stream nobody holds.
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const pending: ExtensionEvent[] = [];
    const encoder = new TextEncoder();
    const write = (stream: ReadableStreamDefaultController<Uint8Array>, event: ExtensionEvent): void => {
        try {
            stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
            // allow(silent-catch): a stream the extension already let go of is no longer one to write to
            streams.delete(stream);
        }
    };
    const send = (event: ExtensionEvent): void => {
        if (streams.size === 0) {
            pending.push(event);
            return;
        }
        for (const stream of streams) {
            write(stream, event);
        }
    };

    const eventStream = (signal: AbortSignal | null): Response => {
        let held: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                held = controller;
                streams.add(controller);
                write(controller, { kind: "heartbeat" });
                for (const event of pending.splice(0)) {
                    write(controller, event);
                }
            },
            cancel: () => {
                if (held !== undefined) {
                    streams.delete(held);
                }
            },
        });
        signal?.addEventListener("abort", () => {
            if (held !== undefined) {
                streams.delete(held);
            }
        });
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    };

    // The daemon's side of the wire: the token checked, the reach judged, then the extension's own routes or the test's.
    const daemon = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const line = `${request.method} ${url.pathname}`;
        if (request.headers.get(EXTENSION_TOKEN_HEADER) !== TOKEN) {
            calls.push({ line, admitted: false });
            return json({ error: "unauthorized" }, 401);
        }
        const admitted = extensionRouteReach(reach, request.method, url.pathname);
        calls.push({ line, admitted });
        if (!admitted) {
            return json({ error: "extension token not valid for this route" }, 403);
        }
        if (request.method === "GET" && url.pathname === extensionSettingsUrl()) {
            return json({ settings });
        }
        if (request.method === "GET" && url.pathname === extensionEventsUrl()) {
            return eventStream(init?.signal ?? null);
        }
        return (await options.daemon?.(request)) ?? json({ error: "not found" }, 404);
    };

    const slots = createServerApi({
        id,
        daemonUrl: DAEMON,
        token: TOKEN,
        permissions: reach.permissions,
        workspaceRoot,
        extensionDir: await dirOf(options.extensionDir, "checkout"),
        stateDir: await dirOf(options.stateDir, "state"),
        cacheDir: await dirOf(options.cacheDir, "cache"),
        log: (message) => logs.push(message),
        fetch: daemon,
    });
    let activation: ServerActivation = {};

    return {
        api: slots.api,
        calls,
        logs,
        activate: async (module) => {
            activation = await activateServerModule(module, slots.api, { extensionId: id });
        },
        route: async (path, init) => {
            const handler = slots.handler();
            if (handler === undefined) {
                return json({ error: `the "${id}" backend serves no routes` }, 404);
            }
            return (await handler(new Request(new URL(path, "http://extension.internal"), init))) ?? json({ error: "not found" }, 404);
        },
        tools: async (card) => (await slots.tools()?.(card)) ?? [],
        callTool: async (name, args = {}, card, context = {}) => {
            const tool = ((await slots.tools()?.(card)) ?? []).find((each) => each.name === name);
            if (tool === undefined) {
                throw new Error(`"${id}" serves no tool named ${name}${card === undefined ? "" : ` for card ${card.id}`}`);
            }
            return tool.call(args, { signal: context.signal ?? new AbortController().signal, conversationId: context.conversationId });
        },
        setSettings: (values) => {
            const keys = changedKeys(settings, values);
            settings = { ...values };
            if (keys.length > 0) {
                send({ kind: "settings", keys });
            }
        },
        emit: send,
        health: () => healthWithin(activation),
        deactivate: () => deactivateWithin(activation, (message) => logs.push(message)),
        dispose: async () => {
            slots.close();
            for (const stream of streams) {
                try {
                    stream.close();
                } catch {
                    // allow(silent-catch): already closed by the extension's side, which is the state being reached
                }
            }
            streams.clear();
            await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
        },
    };
};
