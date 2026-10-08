import { dirname } from "node:path";
import type {
    CredentialEntry,
    McpAddInput,
    McpServer,
    MigrationV1StatusOutput,
    OpenCodeClient,
    OpenCodeEvent,
    PermissionReplyInput,
    SessionInfo,
} from "@opencode/client";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { CommandGuard } from "../../guard/command-guard.js";
import { DAEMON_OWNER, WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import {
    createOpenCodeService,
    OPENCODE_IDLE_STOP_MS,
    openCodeIdleStop,
    type OpenCodeGeminiConfig,
    type OpenCodeService,
    type SessionJudge,
} from "./opencode.js";
import { type OpenCodeConfig, SERVER_PERMISSIONS } from "./opencode-config.js";
import type { McpRemoteConfig, OpenCodeMcpServer } from "./opencode-mcp.js";
import type { ServeRequest, SpawnServer } from "./opencode-serve.js";
import { SEED_XAI_MODELS } from "./xai-models.js";
import { WORKSPACE_ROOT } from "@intentic/constants";

// The service's lifecycle against a stand-in `opencode serve`: the spawn, the client and the process table are fakes, so
// nothing here starts a process or reaches a socket. A real child under the service is opencode-reboot.integration.test.ts.

// The service's data root: never created, since the spawn is a fake and the catalog file boot looks for is absent.
const XDG = "/nonexistent/opencode-env/xdg";

type ServiceOptions = NonNullable<Parameters<typeof createOpenCodeService>[1]>;
type GeminiModels = Awaited<ReturnType<OpenCodeGeminiConfig["models"]>>;
type Mcp = OpenCodeClient["mcp"];

const CONNECTED: OpenCodeEvent = { id: "evt_connected", type: "server.connected", data: {} };

// A server's one event stream as the test drives it: it opens with `server.connected` unless held, then carries what the
// test pushes, until the test ends or breaks it or the service aborts it.
interface FakeStream {
    readonly subscribe: OpenCodeClient["event"]["subscribe"];
    readonly connect: () => void;
    readonly push: (event: OpenCodeEvent) => void;
    readonly end: () => void;
    readonly fail: (error: Error) => void;
    readonly aborted: () => boolean;
}

const fakeStream = (connects: boolean, opened: () => void): FakeStream => {
    const queue: OpenCodeEvent[] = connects ? [CONNECTED] : [];
    let finish: Error | "ended" | undefined;
    let wake: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const poke = (): void => {
        wake?.();
        wake = undefined;
    };
    return {
        subscribe: (options) => {
            signal = options?.signal;
            signal?.addEventListener("abort", poke);
            opened();
            return (async function* () {
                for (;;) {
                    if (signal?.aborted === true) {
                        return;
                    }
                    const next = queue.shift();
                    if (next !== undefined) {
                        yield next;
                        continue;
                    }
                    if (finish === "ended") {
                        return;
                    }
                    if (finish !== undefined) {
                        throw finish;
                    }
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                }
            })();
        },
        connect: () => {
            queue.push(CONNECTED);
            poke();
        },
        push: (event) => {
            queue.push(event);
            poke();
        },
        end: () => {
            finish = "ended";
            poke();
        },
        fail: (error) => {
            finish = error;
            poke();
        },
        aborted: () => signal?.aborted === true,
    };
};

type McpCall =
    | { readonly call: "add"; readonly server: string; readonly directory: string | undefined; readonly config: McpAddInput["config"] }
    | { readonly call: "remove"; readonly server: string; readonly directory: string | undefined };

// What the service asks of one server's client; each call a test reads is recorded or mockable.
const fakeClient = (stream: FakeStream) => {
    const mcpCalls: McpCall[] = [];
    const replies: PermissionReplyInput[] = [];
    const replyWaiters: ((reply: PermissionReplyInput) => void)[] = [];
    const reply = jest.fn<OpenCodeClient["permission"]["reply"]>(async (input) => {
        replies.push(input);
        for (const waiter of replyWaiters.splice(0)) {
            waiter(input);
        }
    });
    const added = new Set<string>();
    const add = jest.fn<Mcp["add"]>(async (input) => {
        mcpCalls.push({ call: "add", server: input.server, directory: input.location?.directory, config: input.config });
        added.add(input.server);
    });
    const remove = jest.fn<Mcp["remove"]>(async (input) => {
        mcpCalls.push({ call: "remove", server: input.server, directory: input.location?.directory });
        added.delete(input.server);
    });
    // Every added server connects at once unless a test says otherwise.
    const list = jest.fn<Mcp["list"]>(async (input) => ({
        location: { directory: input?.location?.directory ?? "" },
        data: [...added].map((name): McpServer => ({ name, status: { status: "connected" } })),
    }));
    const get = jest.fn<OpenCodeClient["session"]["get"]>();
    const status = jest.fn<OpenCodeClient["migration"]["v1"]["status"]>(async (): Promise<MigrationV1StatusOutput> => ({ status: "completed" }));
    const credentials = jest.fn<OpenCodeClient["credential"]["list"]>(async () => []);
    const removeCredential = jest.fn<OpenCodeClient["credential"]["remove"]>(async () => {});
    const client = unstubbed<OpenCodeClient>("opencode client", {
        event: unstubbed<OpenCodeClient["event"]>("opencode client.event", { subscribe: stream.subscribe }),
        permission: unstubbed<OpenCodeClient["permission"]>("opencode client.permission", { reply }),
        mcp: unstubbed<Mcp>("opencode client.mcp", { add, remove, list }),
        session: unstubbed<OpenCodeClient["session"]>("opencode client.session", { get }),
        migration: { v1: { status } },
        credential: unstubbed<OpenCodeClient["credential"]>("opencode client.credential", { list: credentials, remove: removeCredential }),
    });
    return {
        client,
        stream,
        replies,
        // The next permission reply this client sends; armed before the ask is pushed.
        nextReply: (): Promise<PermissionReplyInput> => new Promise((resolve) => void replyWaiters.push(resolve)),
        mcpCalls,
        mcp: { add, remove, list },
        session: { get },
        migration: { status },
        credential: { list: credentials, remove: removeCredential },
    };
};

type FakeClient = ReturnType<typeof fakeClient>;

interface FakeServer {
    readonly request: ServeRequest;
    // The inline config the server was spawned with, as OpenCode would read it.
    readonly config: OpenCodeConfig;
    readonly url: string;
    readonly fake: FakeClient;
    closes: number;
    // The process ends by itself (an OOM kill): its exit listeners run.
    readonly exit: (summary: string) => void;
}

// Far past any pid_max, so a stand-in pid can never name a real process.
const FIRST_PID = 2_000_000_000;

// SAFETY: the service writes OPENCODE_CONFIG_CONTENT as the JSON of the OpenCodeConfig it built (serverConfig).
const configOf = (request: ServeRequest): OpenCodeConfig => JSON.parse(request.env["OPENCODE_CONFIG_CONTENT"] ?? "") as OpenCodeConfig;

const services: OpenCodeService[] = [];

afterEach(async () => {
    jest.useRealTimers();
    await Promise.all(services.splice(0).map((service) => service.stop()));
});

// The real service over a fake spawn, client and process table. Each spawn is one FakeServer; a closed one is gone from
// the process table at once, so the service's exit wait never polls.
const runtime = (options: Omit<ServiceOptions, "spawnServer" | "makeClient" | "alive"> = {}) => {
    const servers: FakeServer[] = [];
    const live = new Set<number>();
    const opened: PromiseWithResolvers<void>[] = [];
    const openedAt = (index: number): PromiseWithResolvers<void> => (opened[index] ??= Promise.withResolvers<void>());
    const made: { url: string; headers: Readonly<Record<string, string>> }[] = [];
    const settings = { connects: true };
    const spawnServer = jest.fn<SpawnServer>(async (request) => {
        const index = servers.length;
        const pid = FIRST_PID + index;
        const exitListeners: ((summary: string) => void)[] = [];
        let exited: string | undefined;
        const stream = fakeStream(settings.connects, () => openedAt(index).resolve());
        const server: FakeServer = {
            request,
            config: configOf(request),
            url: `http://127.0.0.1:${String(4100 + index)}`,
            fake: fakeClient(stream),
            closes: 0,
            exit: (summary) => {
                live.delete(pid);
                exited = summary;
                for (const listener of exitListeners.splice(0)) {
                    listener(summary);
                }
            },
        };
        servers.push(server);
        live.add(pid);
        return {
            url: server.url,
            headers: { authorization: `Basic server-${String(index)}` },
            process: { pid, stamp: `stamp-${String(index)}` },
            close: () => {
                server.closes += 1;
                live.delete(pid);
            },
            onExit: (listener) => {
                if (exited === undefined) {
                    exitListeners.push(listener);
                } else {
                    listener(exited);
                }
            },
        };
    });
    const service = createOpenCodeService(XDG, {
        ...options,
        spawnServer,
        makeClient: ({ url, headers }) => {
            made.push({ url, headers });
            const server = servers.find((candidate) => candidate.url === url);
            if (server === undefined) {
                throw new Error(`no stand-in server listens on ${url}`);
            }
            return server.fake.client;
        },
        alive: (pid) => live.has(pid),
    });
    services.push(service);
    const at = (index: number): FakeServer => {
        const server = servers[index];
        if (server === undefined) {
            throw new Error(`the service spawned ${String(servers.length)} servers, not ${String(index + 1)}`);
        }
        return server;
    };
    return {
        service,
        servers,
        spawnServer,
        made,
        settings,
        at,
        // Resolves once the service has opened the stream of the index-th server it spawned.
        opened: (index: number): Promise<void> => openedAt(index).promise,
        closes: (): number[] => servers.map((server) => server.closes),
    };
};

const OLD_MODEL = { id: "claude-opus-4-6-thinking", inputModalities: ["text", "image"] } as const;
const NEW_MODEL = { id: "claude-opus-5-5-high", inputModalities: ["text", "image"] } as const;
const OLD_SELECTION = { providerID: OPENCODE_GEMINI_PROVIDER, modelID: OLD_MODEL.id };
const NEW_SELECTION = { providerID: OPENCODE_GEMINI_PROVIDER, modelID: NEW_MODEL.id };
const GROK = { providerID: "xai", modelID: "grok-4" };

// The service with Google configured, its catalog a mock that lists the old model until a test says otherwise.
const googleRuntime = (options: Omit<ServiceOptions, "spawnServer" | "makeClient" | "alive" | "gemini"> = {}) => {
    const models = jest.fn<OpenCodeGeminiConfig["models"]>().mockResolvedValue([OLD_MODEL]);
    return { ...runtime({ ...options, gemini: { baseUrl: "http://127.0.0.1:8789", token: "local", models } }), models };
};

const geminiModel = (id: string, input: string[]) => ({ name: id, capabilities: { tools: true, input, output: ["text"] } });
const registeredGoogleModels = (server: FakeServer) => server.config.providers?.[OPENCODE_GEMINI_PROVIDER]?.models;
const xaiModels = Object.fromEntries(SEED_XAI_MODELS.map((id) => [id, { body: { store: false }, capabilities: { tools: true } }]));

// Whether a promise has settled yet, read without awaiting it.
const tracked = <T>(promise: Promise<T>): (() => boolean) => {
    let settled = false;
    promise.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    return () => settled;
};

// One turn of the event loop, so detached work the last step started (a stream read, an exit listener) runs.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const asked = (id: string, sessionID: string, command: string): OpenCodeEvent => ({
    id: `evt_${id}`,
    created: 0,
    type: "permission.asked",
    data: { id, sessionID, action: "shell", resources: [command] },
});

const idle = (sessionID: string): OpenCodeEvent => ({ id: `evt_idle_${sessionID}`, created: 0, type: "session.idle", data: { sessionID } });

describe("boot", () => {
    test("the first call spawns one server with its config inline, OpenCode's lockdown switches, its data home and the daemon's stamp", async () => {
        const before = { ...process.env };
        const fake = runtime({ port: 4096 });

        const client = await fake.service.client();

        expect(fake.spawnServer).toHaveBeenCalledTimes(1);
        const server = fake.at(0);
        const { PATH, OPENCODE_CONFIG_CONTENT, ...env } = server.request.env;
        expect(env).toEqual({
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            XDG_DATA_HOME: XDG,
            [WORKLOAD_ENV]: DAEMON_OWNER,
        });
        expect(OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(server.config));
        // The binary is the engine store's or the image's copy where one resolves, and an `opencode` the server starts
        // for itself finds the same one first; with neither, the bare name and the daemon's PATH as it is.
        expect(PATH).toBe(server.request.binary === "opencode" ? undefined : `${dirname(server.request.binary)}:${before["PATH"] ?? ""}`);
        expect(server.request.port).toBe(4096);
        expect(server.config).toEqual({
            update: "disable",
            share: "disabled",
            permissions: [...SERVER_PERMISSIONS],
            // No Gemini configured, no Google provider; every known xAI model opts out of server-side storage.
            providers: { xai: { models: xaiModels } },
        });
        // The rules the owner's rulebook depends on: a shell command it should see is asked about, a form nobody renders
        // is denied.
        expect(server.config.permissions).toContainEqual({ action: "shell", resource: "*git push*", effect: "ask" });
        expect(server.config.permissions).toContainEqual({ action: "question", resource: "*", effect: "deny" });
        expect(fake.made).toEqual([{ url: server.url, headers: { authorization: "Basic server-0" } }]);
        expect(client).toBe(server.fake.client);
        // Handed to the child alone: the daemon's own environment is as it was.
        expect({ ...process.env }).toEqual(before);
    });

    test("without a port the kernel picks one", async () => {
        const fake = runtime();
        await fake.service.client();
        expect(fake.at(0).request.port).toBe(0);
    });

    test("a Google catalog with models registers the Google provider with each model's published modalities", async () => {
        const fake = googleRuntime();
        fake.models.mockResolvedValue([OLD_MODEL, { id: "gpt-oss-120b-medium", inputModalities: ["text"] }]);

        await fake.service.client();

        expect(fake.at(0).config.providers).toEqual({
            xai: { models: xaiModels },
            [OPENCODE_GEMINI_PROVIDER]: {
                name: "Gemini",
                package: "aisdk:@ai-sdk/openai-compatible",
                settings: { baseURL: "http://127.0.0.1:8789/v1", apiKey: "local" },
                models: {
                    [OLD_MODEL.id]: geminiModel(OLD_MODEL.id, ["text", "image"]),
                    "gpt-oss-120b-medium": geminiModel("gpt-oss-120b-medium", ["text"]),
                },
            },
        });
    });

    test.each(["fails", "is empty"])("a Google catalog read that %s boots Grok without a Google provider", async (failure) => {
        const fake = googleRuntime();
        if (failure === "fails") {
            fake.models.mockRejectedValueOnce(new Error("translator unavailable"));
        } else {
            fake.models.mockResolvedValueOnce([]);
        }

        await fake.service.client();

        expect(fake.at(0).config.providers).toEqual({ xai: { models: xaiModels } });
    });

    test("concurrent calls boot one server and share its client", async () => {
        const fake = runtime();
        const [first, second, third] = await Promise.all([fake.service.client(), fake.service.client(), fake.service.client()]);
        expect(fake.spawnServer).toHaveBeenCalledTimes(1);
        expect(first).toBe(fake.at(0).fake.client);
        expect(second).toBe(first);
        expect(third).toBe(first);
    });

    test("a failed boot is retried by the next call", async () => {
        const fake = runtime();
        const failure = new Error("OpenCode exited before it was ready (code 1). It said: address in use");
        fake.spawnServer.mockRejectedValueOnce(failure);

        await expect(fake.service.client()).rejects.toThrow(failure);
        const client = await fake.service.client();

        expect(fake.spawnServer).toHaveBeenCalledTimes(2);
        expect(client).toBe(fake.at(0).fake.client);
    });

    test("an event stream that never connects fails the boot and closes its server; the next call boots afresh", async () => {
        jest.useFakeTimers();
        const fake = runtime();
        fake.settings.connects = false;

        const booting = fake.service.client();
        const settled = tracked(booting);
        await fake.opened(0);
        await advanceTimersByTimeAsync(14_999);
        expect(settled()).toBe(false);
        await advanceTimersByTimeAsync(1);

        await expect(booting).rejects.toThrow(new Error("OpenCode's event stream did not connect."));
        expect(fake.closes()).toEqual([1]);
        expect(fake.at(0).fake.stream.aborted()).toBe(true);

        fake.settings.connects = true;
        expect(await fake.service.client()).toBe(fake.at(1).fake.client);
        expect(fake.closes()).toEqual([1, 0]);
    });

    test("stopping while a boot is starting closes that server and rejects the boot; the next call boots afresh", async () => {
        const fake = runtime();
        fake.settings.connects = false;

        const booting = fake.service.client();
        await fake.opened(0);
        await fake.service.stop();
        fake.at(0).fake.stream.connect();

        await expect(booting).rejects.toThrow(new Error("OpenCode was stopped while it was starting."));
        expect(fake.closes()).toEqual([1]);
        expect(fake.at(0).fake.stream.aborted()).toBe(true);

        fake.settings.connects = true;
        expect(await fake.service.client()).toBe(fake.at(1).fake.client);
    });

    // A boot stopped while starting fails once its stream connects, by which time a call made after the stop has
    // published a boot of its own. The stale failure once erased that memo: the next call spawned a third server, and
    // the second then rejected as "stopped while it was starting" though nobody stopped it.
    test("a boot stopped while starting does not erase the boot a later call started", async () => {
        const fake = runtime();
        fake.settings.connects = false;
        const stopped = fake.service.client();
        await fake.opened(0);
        await fake.service.stop();
        const second = fake.service.client();
        await fake.opened(1);

        fake.at(0).fake.stream.connect();
        await expect(stopped).rejects.toThrow(new Error("OpenCode was stopped while it was starting."));
        fake.settings.connects = true;
        const third = fake.service.client();
        fake.at(1).fake.stream.connect();

        const [secondClient, thirdClient] = await Promise.all([second, third]);
        expect(fake.spawnServer).toHaveBeenCalledTimes(2);
        expect(secondClient).toBe(fake.at(1).fake.client);
        expect(thirdClient).toBe(secondClient);
    });

    test("stop is idempotent and leaves the service able to boot a fresh server", async () => {
        const fake = runtime();
        await fake.service.stop();
        expect(fake.spawnServer).toHaveBeenCalledTimes(0);

        await fake.service.client();
        await fake.service.stop();
        await fake.service.stop();
        expect(fake.closes()).toEqual([1]);

        expect(await fake.service.client()).toBe(fake.at(1).fake.client);
        expect(fake.closes()).toEqual([1, 0]);
    });
});

describe("event stream", () => {
    const judgeOf = (outcome: { readonly allow: true } | { readonly allow: false; readonly reason: string }) => {
        const consulted: string[] = [];
        const frames: AgentEvent[] = [];
        const holds: string[] = [];
        const frame: AgentEvent = { kind: "thinking", text: "weighing the command against the rulebook" };
        const consult: CommandGuard["consult"] = async function* (program) {
            consulted.push(program);
            yield frame;
            return outcome;
        };
        const judge: SessionJudge = {
            gate: unstubbed<CommandGuard>("gate", { enforcing: true, consult }),
            push: (event) => void frames.push(event),
            hold: () => {
                holds.push("held");
                return () => void holds.push("released");
            },
        };
        return { judge, consulted, frames, holds, frame };
    };

    test("an ask for a session nobody judges is answered for this call only", async () => {
        const fake = runtime();
        await fake.service.client();
        const server = fake.at(0).fake;

        const reply = server.nextReply();
        server.stream.push(asked("per_1", "ses_1", "git push origin main"));

        expect(await reply).toEqual({ sessionID: "ses_1", requestID: "per_1", decision: "once" });
        expect(server.replies).toHaveLength(1);
    });

    test("an ask for a registered session goes to its judge, and back to the standing yes once it is released", async () => {
        const fake = runtime();
        await fake.service.client();
        const server = fake.at(0).fake;
        const recorded = judgeOf({ allow: false, reason: "Pushing is the owner's call." });
        fake.service.judges.register("ses_judged", recorded.judge);

        const refused = server.nextReply();
        server.stream.push(asked("per_1", "ses_judged", "git push origin main"));
        expect(await refused).toEqual({ sessionID: "ses_judged", requestID: "per_1", decision: "reject", message: "Pushing is the owner's call." });
        expect(recorded.consulted).toEqual(["git push origin main"]);
        expect(recorded.frames).toEqual([recorded.frame]);
        expect(recorded.holds).toEqual(["held", "released"]);

        // Another session on the same stream is not this judge's.
        const other = server.nextReply();
        server.stream.push(asked("per_2", "ses_other", "git push origin main"));
        expect(await other).toEqual({ sessionID: "ses_other", requestID: "per_2", decision: "once" });

        fake.service.judges.release("ses_judged");
        const released = server.nextReply();
        server.stream.push(asked("per_3", "ses_judged", "git push origin main"));
        expect(await released).toEqual({ sessionID: "ses_judged", requestID: "per_3", decision: "once" });
        expect(recorded.consulted).toEqual(["git push origin main"]);
    });

    test("every lease listens on the server's one stream, until it stops listening", async () => {
        const fake = runtime();
        const first = await fake.service.acquire(GROK);
        const second = await fake.service.acquire(GROK);
        const heard: string[] = [];
        const stopFirst = first.listen({ event: (event) => void heard.push(`first ${event.type}`), lost: () => void heard.push("first lost") });
        second.listen({ event: (event) => void heard.push(`second ${event.type}`), lost: () => void heard.push("second lost") });

        fake.at(0).fake.stream.push(idle("ses_1"));
        await flush();
        stopFirst();
        fake.at(0).fake.stream.push(idle("ses_2"));
        await flush();

        expect(heard).toEqual(["first session.idle", "second session.idle", "second session.idle"]);
        first.release();
        second.release();
    });

    test.each([
        ["ends", (stream: FakeStream) => stream.end(), new Error("OpenCode's event stream ended.")],
        ["breaks", (stream: FakeStream) => stream.fail(new Error("socket hang up")), new Error("socket hang up")],
    ])("a stream that %s tells its listeners and forgets the server, so the next call boots afresh", async (_how, lose, reason) => {
        const fake = runtime();
        const lease = await fake.service.acquire(GROK);
        const lost = Promise.withResolvers<Error>();
        lease.listen({ event: () => {}, lost: lost.resolve });

        lose(fake.at(0).fake.stream);

        expect(await lost.promise).toEqual(reason);
        expect(fake.closes()).toEqual([1]);
        lease.release();
        expect(await fake.service.client()).toBe(fake.at(1).fake.client);
        expect(fake.spawnServer).toHaveBeenCalledTimes(2);
    });

    test("a server that exits is forgotten, so the next call boots afresh", async () => {
        const fake = runtime();
        await fake.service.client();

        fake.at(0).exit("OpenCode's server exited (SIGKILL).");

        expect(fake.at(0).fake.stream.aborted()).toBe(true);
        expect(await fake.service.client()).toBe(fake.at(1).fake.client);
        // Already gone: nothing is left to signal.
        expect(fake.closes()).toEqual([0, 0]);
    });

    // A turn mid-prompt on a server the kernel killed once waited for its watchdog: the exit closed the stream without
    // telling its listeners, so it heard only if the dying socket's error beat the exit event.
    test("a turn listening when its server exits is told its stream is lost", async () => {
        const fake = runtime();
        const lease = await fake.service.acquire(GROK);
        const lost: Error[] = [];
        lease.listen({ event: () => {}, lost: (reason) => void lost.push(reason) });

        fake.at(0).exit("OpenCode's server exited (SIGKILL).");
        await flush();

        expect(lost).toEqual([new Error("OpenCode's server exited (SIGKILL).")]);
        lease.release();
    });

    test("an exit or a lost stream from an earlier boot leaves its replacement alone", async () => {
        const fake = runtime();
        await fake.service.client();
        await fake.service.stop();
        const replacement = await fake.service.client();

        fake.at(0).exit("OpenCode's server exited (SIGTERM).");
        fake.at(0).fake.stream.fail(new Error("socket hang up"));
        await flush();

        expect(await fake.service.client()).toBe(replacement);
        expect(fake.spawnServer).toHaveBeenCalledTimes(2);
        expect(fake.closes()).toEqual([1, 0]);
        // The replacement's stream still answers asks.
        const reply = fake.at(1).fake.nextReply();
        fake.at(1).fake.stream.push(asked("per_1", "ses_1", "rm -rf build"));
        expect(await reply).toEqual({ sessionID: "ses_1", requestID: "per_1", decision: "once" });
    });
});

describe("acquisitions", () => {
    test("acquisitions run in order: one queued behind a Google catalog read waits for it", async () => {
        const fake = googleRuntime();
        await fake.service.client();
        const reading = Promise.withResolvers<GeminiModels>();
        const entered = Promise.withResolvers<void>();
        fake.models.mockImplementationOnce(() => {
            entered.resolve();
            return reading.promise;
        });
        const order: string[] = [];

        const google = fake.service.acquire(OLD_SELECTION).then((lease) => {
            order.push("google");
            return lease;
        });
        const grok = fake.service.acquire(GROK).then((lease) => {
            order.push("grok");
            return lease;
        });
        await entered.promise;
        await flush();
        expect(order).toEqual([]);

        reading.resolve([OLD_MODEL]);
        const leases = await Promise.all([google, grok]);

        expect(order).toEqual(["google", "grok"]);
        for (const lease of leases) {
            lease.release();
        }
    });

    test("only a Google acquisition reads Google's catalog; a Grok one never waits on it or restarts for it", async () => {
        const fake = googleRuntime();
        const previous = await fake.service.client();
        fake.models.mockClear();
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);

        const grok = await fake.service.acquire(GROK);

        expect(grok.client).toBe(previous);
        expect(fake.models).not.toHaveBeenCalled();
        expect(fake.spawnServer).toHaveBeenCalledTimes(1);
        grok.release();
    });

    test("an idle server registers a newly listed Google model before the next Google turn, routed as the shield says", async () => {
        const fake = googleRuntime({ route: async (provider) => `http://127.0.0.1:9000/${provider}` });
        const previous = await fake.service.client();
        fake.models.mockClear();
        // A second discovery would be stale again: the boot must register the exact snapshot the acquisition compared.
        fake.models.mockResolvedValueOnce([OLD_MODEL, NEW_MODEL]);

        const lease = await fake.service.acquire(NEW_SELECTION);

        expect(previous).toBe(fake.at(0).fake.client);
        expect(lease.client).toBe(fake.at(1).fake.client);
        expect(fake.closes()).toEqual([1, 0]);
        expect(fake.models).toHaveBeenCalledTimes(1);
        expect(fake.at(1).config.providers).toEqual({
            xai: { settings: { baseURL: "http://127.0.0.1:9000/grok" }, models: xaiModels },
            [OPENCODE_GEMINI_PROVIDER]: {
                name: "Gemini",
                package: "aisdk:@ai-sdk/openai-compatible",
                settings: { baseURL: "http://127.0.0.1:9000/gemini/v1", apiKey: "local" },
                models: {
                    [OLD_MODEL.id]: geminiModel(OLD_MODEL.id, ["text", "image"]),
                    [NEW_MODEL.id]: geminiModel(NEW_MODEL.id, ["text", "image"]),
                },
            },
        });
        lease.release();
    });

    test("a modality-only catalog change restarts an idle server with the model's new capabilities", async () => {
        const fake = googleRuntime();
        const previous = await fake.service.client();
        fake.models.mockResolvedValue([{ id: OLD_MODEL.id, inputModalities: ["text"] }]);

        const lease = await fake.service.acquire(OLD_SELECTION);

        expect(lease.client).not.toBe(previous);
        expect(fake.spawnServer).toHaveBeenCalledTimes(2);
        expect(registeredGoogleModels(fake.at(1))).toEqual({ [OLD_MODEL.id]: geminiModel(OLD_MODEL.id, ["text"]) });
        lease.release();
    });

    test("an identical catalog, or the same one reordered, reuses the server", async () => {
        const fake = googleRuntime();
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);
        const previous = await fake.service.client();

        const identical = await fake.service.acquire(NEW_SELECTION);
        identical.release();
        fake.models.mockResolvedValue([
            { id: NEW_MODEL.id, inputModalities: ["image", "text"] },
            { id: OLD_MODEL.id, inputModalities: ["image", "text"] },
        ]);
        const reordered = await fake.service.acquire(NEW_SELECTION);

        expect(identical.client).toBe(previous);
        expect(reordered.client).toBe(previous);
        expect(fake.spawnServer).toHaveBeenCalledTimes(1);
        expect(fake.closes()).toEqual([0]);
        reordered.release();
    });

    test.each([OPENCODE_GEMINI_PROVIDER, "xai"])("a busy %s lease keeps the server; only a model it lacks is refused until it is idle", async (providerID) => {
        const fake = googleRuntime();
        const first = await fake.service.acquire(providerID === "xai" ? GROK : OLD_SELECTION);
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);
        const refusal = new Error(
            "Google's model catalog has refreshed, but its shared runtime is still running other turns. Send again once they finish to use claude-opus-5-5-high.",
        );

        const existing = await fake.service.acquire(OLD_SELECTION);
        expect(existing.client).toBe(first.client);
        await expect(fake.service.acquire(NEW_SELECTION)).rejects.toThrow(refusal);
        expect(fake.spawnServer).toHaveBeenCalledTimes(1);
        expect(fake.closes()).toEqual([0]);

        first.release();
        // The other turn still holds it, even after the one that held it first has finished.
        await expect(fake.service.acquire(NEW_SELECTION)).rejects.toThrow(refusal);
        existing.release();

        const next = await fake.service.acquire(NEW_SELECTION);
        expect(next.client).toBe(fake.at(1).fake.client);
        expect(fake.closes()).toEqual([1, 0]);
        next.release();
    });

    test("concurrent acquisitions refresh once, leases count every turn, and a second release is a no-op", async () => {
        const fake = googleRuntime();
        await fake.service.client();
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);

        const [first, second] = await Promise.all([fake.service.acquire(NEW_SELECTION), fake.service.acquire(NEW_SELECTION)]);
        expect(fake.spawnServer).toHaveBeenCalledTimes(2);
        expect(fake.closes()).toEqual([1, 0]);
        expect(second.client).toBe(first.client);

        first.release();
        first.release();
        const third = { id: "gemini-next", inputModalities: ["text", "image"] } as const;
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL, third]);
        const selection = { providerID: OPENCODE_GEMINI_PROVIDER, modelID: third.id };
        // Released twice, the first lease still counts once: the second turn keeps the server.
        await expect(fake.service.acquire(selection)).rejects.toThrow(/Send again once they finish to use gemini-next\.$/);

        second.release();
        const next = await fake.service.acquire(selection);
        expect(fake.spawnServer).toHaveBeenCalledTimes(3);
        expect(Object.keys(registeredGoogleModels(fake.at(2)) ?? {})).toEqual([OLD_MODEL.id, NEW_MODEL.id, third.id]);
        next.release();
    });

    test("a stalled Google catalog read gives up after five seconds without holding up warm Grok or the queue", async () => {
        const fake = googleRuntime();
        const previous = await fake.service.client();
        const entered = Promise.withResolvers<void>();
        const stalled = Promise.withResolvers<GeminiModels>();
        fake.models.mockImplementationOnce(() => {
            entered.resolve();
            return stalled.promise;
        });
        jest.useFakeTimers();

        const grok = await fake.service.acquire(GROK);
        const google = fake.service.acquire(OLD_SELECTION);
        const queued = fake.service.acquire(GROK);
        const googleSettled = tracked(google);
        const queuedSettled = tracked(queued);
        await entered.promise;
        await advanceTimersByTimeAsync(4_999);
        expect([googleSettled(), queuedSettled()]).toEqual([false, false]);
        await advanceTimersByTimeAsync(1);

        const leases = [grok, await google, await queued];
        expect(leases.map((lease) => lease.client)).toEqual([previous, previous, previous]);
        expect(fake.spawnServer).toHaveBeenCalledTimes(1);
        // A late answer must not change the registration behind turns that already hold the server.
        stalled.resolve([OLD_MODEL, NEW_MODEL]);
        await flush();
        expect(fake.spawnServer).toHaveBeenCalledTimes(1);
        expect(fake.closes()).toEqual([0]);
        expect(registeredGoogleModels(fake.at(0))).toEqual({ [OLD_MODEL.id]: geminiModel(OLD_MODEL.id, ["text", "image"]) });
        for (const lease of leases) {
            lease.release();
        }

        jest.useRealTimers();
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);
        const retry = await fake.service.acquire(NEW_SELECTION);
        expect(retry.client).toBe(fake.at(1).fake.client);
        expect(Object.keys(registeredGoogleModels(fake.at(1)) ?? {})).toEqual([OLD_MODEL.id, NEW_MODEL.id]);
        retry.release();
    });

    test.each(["fails", "is empty"])("a catalog refresh that %s keeps the working registration and is retried later", async (failure) => {
        const fake = googleRuntime();
        const previous = await fake.service.client();
        if (failure === "fails") {
            fake.models.mockRejectedValueOnce(new Error("translator unavailable"));
        } else {
            fake.models.mockResolvedValueOnce([]);
        }

        const unchanged = await fake.service.acquire(OLD_SELECTION);
        expect(unchanged.client).toBe(previous);
        expect(fake.spawnServer).toHaveBeenCalledTimes(1);
        expect(fake.closes()).toEqual([0]);
        unchanged.release();

        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);
        const recovered = await fake.service.acquire(NEW_SELECTION);
        expect(recovered.client).toBe(fake.at(1).fake.client);
        expect(Object.keys(registeredGoogleModels(fake.at(1)) ?? {})).toEqual([OLD_MODEL.id, NEW_MODEL.id]);
        recovered.release();
    });

    test.each(["fails", "is empty"])("a server booted while its catalog read %s registers Google on the next Google turn", async (failure) => {
        const fake = googleRuntime();
        if (failure === "fails") {
            fake.models.mockRejectedValueOnce(new Error("translator unavailable"));
        } else {
            fake.models.mockResolvedValueOnce([]);
        }
        await fake.service.client();
        expect(registeredGoogleModels(fake.at(0))).toBeUndefined();
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);

        const lease = await fake.service.acquire(NEW_SELECTION);

        expect(lease.client).toBe(fake.at(1).fake.client);
        expect(Object.keys(registeredGoogleModels(fake.at(1)) ?? {})).toEqual([OLD_MODEL.id, NEW_MODEL.id]);
        lease.release();
    });

    test("a failed boot neither poisons the acquisitions queued behind it nor leaks an active lease", async () => {
        const fake = googleRuntime();
        const failure = new Error("boot failed");
        fake.spawnServer.mockRejectedValueOnce(failure);

        const failed = fake.service.acquire(OLD_SELECTION);
        const waiting = fake.service.acquire(OLD_SELECTION);
        await expect(failed).rejects.toThrow(failure);
        const lease = await waiting;
        expect(fake.spawnServer).toHaveBeenCalledTimes(2);
        lease.release();

        // Had the failed acquisition kept its count, this server would read as busy and refuse the new model.
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);
        const next = await fake.service.acquire(NEW_SELECTION);
        expect(fake.spawnServer).toHaveBeenCalledTimes(3);
        expect(fake.closes()).toEqual([1, 0]);
        expect(Object.keys(registeredGoogleModels(fake.at(1)) ?? {})).toEqual([OLD_MODEL.id, NEW_MODEL.id]);
        next.release();
    });

    test("a failed refresh boot is retried by the next acquisition", async () => {
        const fake = googleRuntime();
        await fake.service.client();
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);
        const failure = new Error("refresh boot failed");
        fake.spawnServer.mockRejectedValueOnce(failure);

        await expect(fake.service.acquire(NEW_SELECTION)).rejects.toThrow(failure);
        const next = await fake.service.acquire(NEW_SELECTION);

        expect(fake.spawnServer).toHaveBeenCalledTimes(3);
        expect(fake.closes()).toEqual([1, 0]);
        expect(next.client).toBe(fake.at(1).fake.client);
        expect(Object.keys(registeredGoogleModels(fake.at(1)) ?? {})).toEqual([OLD_MODEL.id, NEW_MODEL.id]);
        next.release();
    });

    test("a registered session judge also keeps an idle refresh from restarting the server", async () => {
        const fake = googleRuntime();
        await fake.service.client();
        fake.service.judges.register("legacy", {
            gate: unstubbed<CommandGuard>("gate", { enforcing: true }),
            push: () => {},
            hold: () => () => {},
        });
        fake.models.mockResolvedValue([OLD_MODEL, NEW_MODEL]);

        await expect(fake.service.acquire(NEW_SELECTION)).rejects.toThrow(/Send again once they finish to use claude-opus-5-5-high\.$/);
        expect(fake.closes()).toEqual([0]);

        fake.service.judges.release("legacy");
        const lease = await fake.service.acquire(NEW_SELECTION);
        expect(fake.spawnServer).toHaveBeenCalledTimes(2);
        expect(lease.client).toBe(fake.at(1).fake.client);
        lease.release();
    });
});

describe("idle stop", () => {
    const IDLE_MS = 60_000;
    const base = { booted: true, activeTurns: 0, judges: 0, lastUsedAt: 1_000, now: 1_000 + IDLE_MS, idleMs: IDLE_MS };

    test.each([
        ["idle for exactly the span", {}, true],
        ["idle for longer", { now: 1_000 + IDLE_MS * 2 }, true],
        ["one millisecond short of the span", { now: 1_000 + IDLE_MS - 1 }, false],
        ["not booted", { booted: false }, false],
        ["a turn holds it", { activeTurns: 1 }, false],
        ["a session judge holds it", { judges: 1 }, false],
    ])("openCodeIdleStop: %s", (_case, change, stops) => {
        expect(openCodeIdleStop({ ...base, ...change })).toBe(stops);
    });

    test("the default span is half an hour", () => {
        expect(OPENCODE_IDLE_STOP_MS).toBe(1_800_000);
    });

    test("a server nothing used for the idle span is stopped, and the next call boots afresh", async () => {
        jest.useFakeTimers();
        const fake = runtime({ idleStopMs: IDLE_MS });
        await fake.service.client();

        // The clock looks every sixth of the span, so the look at the span's end is the first to find it idle long enough.
        await advanceTimersByTimeAsync(IDLE_MS - 1);
        expect(fake.closes()).toEqual([0]);
        await advanceTimersByTimeAsync(1);
        expect(fake.closes()).toEqual([1]);

        expect(await fake.service.client()).toBe(fake.at(1).fake.client);
    });

    test("a held lease keeps the server however long, and the span restarts when it is released", async () => {
        jest.useFakeTimers();
        const fake = runtime({ idleStopMs: IDLE_MS });
        const lease = await fake.service.acquire(GROK);

        await advanceTimersByTimeAsync(IDLE_MS * 2);
        expect(fake.closes()).toEqual([0]);
        lease.release();
        await advanceTimersByTimeAsync(IDLE_MS - 1);
        expect(fake.closes()).toEqual([0]);
        await advanceTimersByTimeAsync(1);
        expect(fake.closes()).toEqual([1]);
    });

    test("a registered session judge keeps the server until it is released", async () => {
        jest.useFakeTimers();
        const fake = runtime({ idleStopMs: IDLE_MS });
        await fake.service.client();
        fake.service.judges.register("ses_1", { gate: unstubbed<CommandGuard>("gate", { enforcing: true }), push: () => {}, hold: () => () => {} });

        await advanceTimersByTimeAsync(IDLE_MS * 2);
        expect(fake.closes()).toEqual([0]);
        fake.service.judges.release("ses_1");
        // Idle since its boot: the next look stops it.
        await advanceTimersByTimeAsync(IDLE_MS / 6);
        expect(fake.closes()).toEqual([1]);
    });

    test("an idle span of 0 keeps the server for the service's life", async () => {
        jest.useFakeTimers();
        const fake = runtime({ idleStopMs: 0 });
        await fake.service.client();

        await advanceTimersByTimeAsync(OPENCODE_IDLE_STOP_MS * 4);

        expect(fake.closes()).toEqual([0]);
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe("shielded", () => {
    test("with nothing booted the shield has nothing to wait for, and nothing boots to ask", async () => {
        const fake = runtime({ route: async () => "http://127.0.0.1:9000/gateway" });
        expect(await fake.service.shielded()).toBe(true);
        expect(fake.spawnServer).toHaveBeenCalledTimes(0);
    });

    test("an idle server booted under the other routing is closed, and the next boots routed as the shield now says", async () => {
        let shield = false;
        const fake = googleRuntime({ route: async () => (shield ? "http://127.0.0.1:9000/gateway" : undefined) });
        await fake.service.client();
        expect(fake.at(0).config.providers?.["xai"]?.settings).toBeUndefined();
        expect(await fake.service.shielded()).toBe(true);
        expect(fake.closes()).toEqual([0]);

        shield = true;
        expect(await fake.service.shielded()).toBe(true);
        expect(fake.closes()).toEqual([1]);

        const lease = await fake.service.acquire(OLD_SELECTION);
        expect(fake.at(1).config.providers?.["xai"]?.settings).toEqual({ baseURL: "http://127.0.0.1:9000/gateway" });
        expect(fake.at(1).config.providers?.[OPENCODE_GEMINI_PROVIDER]?.settings).toEqual({ baseURL: "http://127.0.0.1:9000/gateway/v1", apiKey: "local" });
        lease.release();
    });

    test("a busy unshielded server stays up, including through an acquisition's own setup, and goes once it is idle", async () => {
        let shield = false;
        const fake = googleRuntime({ route: async () => (shield ? "http://127.0.0.1:9000/gateway" : undefined) });
        await fake.service.client();
        const entered = Promise.withResolvers<void>();
        const discovery = Promise.withResolvers<GeminiModels>();
        fake.models.mockImplementationOnce(() => {
            entered.resolve();
            return discovery.promise;
        });

        const acquiring = fake.service.acquire(OLD_SELECTION);
        await entered.promise;
        shield = true;
        expect(await fake.service.shielded()).toBe(false);
        expect(fake.closes()).toEqual([0]);
        discovery.resolve([OLD_MODEL]);
        const lease = await acquiring;
        expect(await fake.service.shielded()).toBe(false);
        expect(fake.closes()).toEqual([0]);

        lease.release();
        expect(await fake.service.shielded()).toBe(true);
        expect(fake.closes()).toEqual([1]);
    });

    test("a busy server still routed through the gateway the shield no longer needs stays, a harmless relay", async () => {
        let shield = true;
        const fake = runtime({ route: async () => (shield ? "http://127.0.0.1:9000/gateway" : undefined) });
        const lease = await fake.service.acquire(GROK);

        shield = false;
        expect(await fake.service.shielded()).toBe(true);
        expect(fake.closes()).toEqual([0]);

        lease.release();
        expect(await fake.service.shielded()).toBe(true);
        expect(fake.closes()).toEqual([1]);
    });
});

describe("sessionExists", () => {
    const notFound = (): Error => Object.assign(new Error("Session not found: ses_gone"), { name: "SessionNotFoundError" });
    const session: SessionInfo = {
        id: "ses_1",
        projectID: "prj_1",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0, updated: 0 },
        location: { directory: WORKSPACE_ROOT },
    };

    test("a session the server holds exists", async () => {
        const fake = runtime();
        await fake.service.client();
        fake.at(0).fake.session.get.mockResolvedValue(session);

        expect(await fake.service.sessionExists("ses_1", WORKSPACE_ROOT)).toBe(true);
        expect(fake.at(0).fake.session.get).toHaveBeenCalledWith({ sessionID: "ses_1" });
    });

    test.each(["completed", "error"] as const)("a session the server lacks is gone once its OpenCode 1 import is %s", async (status) => {
        const fake = runtime();
        await fake.service.client();
        fake.at(0).fake.session.get.mockRejectedValue(notFound());
        fake.at(0).fake.migration.status.mockResolvedValue(status === "error" ? { status, error: "unreadable history" } : { status });

        expect(await fake.service.sessionExists("ses_gone", WORKSPACE_ROOT)).toBe(false);
    });

    test.each([
        ["required", { status: "required" }],
        ["running", { status: "running", progress: { label: "sessions", numerator: 3, denominator: 9 } }],
    ] as const)("a session missing while the OpenCode 1 import is %s cannot be called gone", async (_status, migration) => {
        const fake = runtime();
        await fake.service.client();
        fake.at(0).fake.session.get.mockRejectedValue(notFound());
        fake.at(0).fake.migration.status.mockResolvedValue(migration);

        await expect(fake.service.sessionExists("ses_gone", WORKSPACE_ROOT)).rejects.toThrow(
            new Error("OpenCode is still moving its earlier sessions over. Send again in a moment."),
        );
    });

    test("any other failure is the caller's to see, and the import is not asked about", async () => {
        const fake = runtime();
        await fake.service.client();
        const failure = new Error("fetch failed");
        fake.at(0).fake.session.get.mockRejectedValue(failure);

        await expect(fake.service.sessionExists("ses_1", WORKSPACE_ROOT)).rejects.toThrow(failure);
        expect(fake.at(0).fake.migration.status).not.toHaveBeenCalled();
    });
});

test("disconnect removes the provider's credentials through the server, and no other provider's", async () => {
    const fake = runtime();
    await fake.service.client();
    const entry = (id: string, integrationID: string): CredentialEntry => ({ id, integrationID, label: id, active: true, value: { type: "key", key: `${id}-key` } });
    fake.at(0).fake.credential.list.mockResolvedValue([entry("cred_grok", "xai"), entry("cred_other", "anthropic"), entry("cred_grok_2", "xai")]);

    await fake.service.disconnect("xai");

    expect(fake.at(0).fake.credential.remove.mock.calls).toEqual([[{ credentialID: "cred_grok" }], [{ credentialID: "cred_grok_2" }]]);
});

describe("MCP mounting", () => {
    const DIRECTORY = `${WORKSPACE_ROOT}/worktree`;
    const NAME = "intentic_0a1b2c3d_web";
    // The wait after a change for OpenCode's tool list to rebuild (MCP_SETTLE_MS), carried on fake time.
    const SETTLE_MS = 300;
    const configFor = (token: string): McpRemoteConfig => ({
        type: "remote",
        url: "http://127.0.0.1:7000/mcp/web",
        headers: { Authorization: `Bearer ${token}` },
        oauth: false,
        codemode: false,
    });
    const serverFor = (token: string): OpenCodeMcpServer => ({ name: NAME, config: configFor(token) });

    // A booted service under fake time, so the mount's settling wait takes none.
    const booted = async () => {
        const fake = runtime();
        await fake.service.client();
        jest.useFakeTimers();
        return fake;
    };
    const mount = async (service: OpenCodeService, servers: readonly OpenCodeMcpServer[]): Promise<() => Promise<void>> => {
        const mounting = service.mount(DIRECTORY, servers);
        await advanceTimersByTimeAsync(SETTLE_MS);
        return mounting;
    };

    test("a turn with no servers mounts nothing and boots nothing", async () => {
        const fake = runtime();
        const release = await fake.service.mount(DIRECTORY, []);
        await release();
        expect(fake.spawnServer).toHaveBeenCalledTimes(0);
    });

    test("a turn's servers are added in its directory once connected, and removed when it lets go", async () => {
        const fake = await booted();
        const opencode = fake.at(0).fake;

        const release = await mount(fake.service, [serverFor("turn-1")]);
        expect(opencode.mcpCalls).toEqual([{ call: "add", server: NAME, directory: DIRECTORY, config: configFor("turn-1") }]);
        expect(opencode.mcp.list).toHaveBeenCalledWith({ location: { directory: DIRECTORY } });

        await release();
        await release();
        expect(opencode.mcpCalls).toEqual([
            { call: "add", server: NAME, directory: DIRECTORY, config: configFor("turn-1") },
            { call: "remove", server: NAME, directory: DIRECTORY },
        ]);
    });

    test("a name two turns hold carries the newer turn's config, and the older one's again once the newer lets go", async () => {
        const fake = await booted();
        const opencode = fake.at(0).fake;

        const releaseOlder = await mount(fake.service, [serverFor("turn-1")]);
        const releaseNewer = await mount(fake.service, [serverFor("turn-2")]);
        await releaseNewer();
        await releaseOlder();

        expect(opencode.mcpCalls).toEqual([
            { call: "add", server: NAME, directory: DIRECTORY, config: configFor("turn-1") },
            { call: "add", server: NAME, directory: DIRECTORY, config: configFor("turn-2") },
            { call: "add", server: NAME, directory: DIRECTORY, config: configFor("turn-1") },
            { call: "remove", server: NAME, directory: DIRECTORY },
        ]);
    });

    test("the older holder letting go first leaves the newer turn's config in place", async () => {
        const fake = await booted();
        const opencode = fake.at(0).fake;

        const releaseOlder = await mount(fake.service, [serverFor("turn-1")]);
        const releaseNewer = await mount(fake.service, [serverFor("turn-2")]);
        await releaseOlder();
        expect(opencode.mcpCalls).toHaveLength(2);
        await releaseNewer();

        expect(opencode.mcpCalls).toEqual([
            { call: "add", server: NAME, directory: DIRECTORY, config: configFor("turn-1") },
            { call: "add", server: NAME, directory: DIRECTORY, config: configFor("turn-2") },
            { call: "remove", server: NAME, directory: DIRECTORY },
        ]);
    });

    test("a server still pending when the connect window closes is given up on, and the turn goes on without it", async () => {
        const fake = await booted();
        const opencode = fake.at(0).fake;
        opencode.mcp.list.mockResolvedValue({ location: { directory: DIRECTORY }, data: [{ name: NAME, status: { status: "pending" } }] });

        const mounting = fake.service.mount(DIRECTORY, [serverFor("turn-1")]);
        const settled = tracked(mounting);
        await advanceTimersByTimeAsync(15_000 + SETTLE_MS - 1);
        expect(settled()).toBe(false);
        await advanceTimersByTimeAsync(1);
        const release = await mounting;

        // Polled every 25ms for the 15s window.
        expect(opencode.mcp.list).toHaveBeenCalledTimes(600);
        await release();
        expect(opencode.mcpCalls.map(({ call }) => call)).toEqual(["add", "remove"]);
    });

    test("a server OpenCode refuses to add is left out rather than failing the turn", async () => {
        const fake = await booted();
        const opencode = fake.at(0).fake;
        opencode.mcp.add.mockRejectedValueOnce(new Error("invalid MCP config"));

        const release = await fake.service.mount(DIRECTORY, [serverFor("turn-1")]);

        expect(opencode.mcp.add).toHaveBeenCalledTimes(1);
        expect(opencode.mcp.list).not.toHaveBeenCalled();
        await release();
    });

    test("mounts are forgotten when the server stops, and mount again on the next boot with the next turn's bearer", async () => {
        const fake = await booted();
        const releaseOld = await mount(fake.service, [serverFor("turn-1")]);

        await fake.service.stop();
        jest.useRealTimers();
        await fake.service.client();
        jest.useFakeTimers();
        const releaseNew = await mount(fake.service, [serverFor("turn-2")]);
        // The stopped server's holder letting go late reaches neither server.
        await releaseOld();
        await releaseNew();

        expect(fake.at(0).fake.mcpCalls).toEqual([{ call: "add", server: NAME, directory: DIRECTORY, config: configFor("turn-1") }]);
        expect(fake.at(1).fake.mcpCalls).toEqual([
            { call: "add", server: NAME, directory: DIRECTORY, config: configFor("turn-2") },
            { call: "remove", server: NAME, directory: DIRECTORY },
        ]);
    });
});
