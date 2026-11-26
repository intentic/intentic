import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeclaredPermissions, declaredReachOf, type ExtensionReach, extensionRouteReach } from "@intentic/extension-manifest/permissions";
import { type PublicRouteContribution, publicRouteAutomationOf, publicRouteFor } from "@intentic/extension-manifest";
import {
    EXTENSION_BROWSER_TOOLS,
    EXTENSION_CALLER_HEADER,
    EXTENSION_CALLER_TTL_MS,
    extensionBrowserUrl,
    ExtensionBrowserCallSchema,
    type ExtensionCallerClaim,
    type ExtensionCallerIdentity,
    EXTENSION_EVENTS_KINDS_PARAM,
    type ExtensionEvent,
    extensionEventsUrl,
    type ExtensionExec,
    type ExtensionExecResult,
    ExtensionExecSchema,
    extensionExecUrl,
    ExtensionJobReportSchema,
    extensionJobsUrl,
    ExtensionJobStartSchema,
    ExtensionNavigateArgumentsSchema,
    ExtensionOwnerBrowserCallSchema,
    extensionOwnerBrowserUrl,
    extensionSettingsUrl,
    extensionWorkHoldUrl,
    ExtensionWorkHoldSchema,
    NO_TOOL_GRANTS,
    readCallerClaim,
} from "@intentic/sandbox-contract/extension-protocol";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/headers";
import { activateServerModule, createServerApi, deactivateWithin, healthWithin } from "./runtime.js";
import type {
    ApprovedAction,
    ApprovedActionOutcome,
    ApprovedPost,
    AutomationFire,
    ExtensionCallerWho,
    ExtensionHealth,
    ExtensionServerApi,
    ExtensionServerModule,
    ExtensionSettingValues,
    PublicRouteVerification,
    JobEnd,
    ServerActivation,
    ToolArguments,
    ToolCard,
    ToolCallContext,
    ToolCallGrants,
    ToolDefinition,
    ToolResult,
    WatchCheck,
    WatchCheckAnswer,
} from "./server.js";

// A backend under test, on the real backend api (runtime.ts) with only the daemon stood in for: every call the extension
// makes is judged by the same reach rule the daemon's grant applies (extension-manifest's extensionRouteReach), so a test
// that passes here does not lean on a route the manifest never declared. Its settings and event stream are the daemon's
// own routes, answered here; everything else the extension is admitted to goes to the test's `daemon` handler.
// Touches the disk (fresh temp directories for whatever the test leaves unnamed), so a suite using it is an
// `*.integration.test.ts`.

const DAEMON = "http://daemon.fake";
const TOKEN = "fake-extension-token";

// The part of a manifest the fake reads: who the extension is, how far it reaches, and what else it declares it may
// hear, hold, run and be woken by (`events`, `work`, `exec`, `fires`), each judged as the daemon judges it.
export interface FakeManifest {
    readonly publisher: string;
    readonly name: string;
    readonly permissions?: ({ readonly daemon?: readonly string[] | undefined } & DeclaredPermissions) | undefined;
    readonly contributes?:
        | {
              readonly listener?: { readonly provider: string } | undefined;
              readonly watchKinds?: readonly { readonly id: string }[] | undefined;
              readonly publicRoutes?: readonly Pick<PublicRouteContribution, "path" | "methods" | "automation">[] | undefined;
          }
        | undefined;
}

// Who a request into `/x` comes from, as the daemon's proxy would assert it (a person's `folders` being what their areas
// come to), and how long ago it was minted (ms): an assertion older than its two-minute window reads as no caller, and
// the daemon refuses it.
export interface FakeRouteOptions {
    readonly caller?: ExtensionCallerWho & { readonly folders?: readonly string[] | undefined };
    readonly mintedAgoMs?: number;
}

export interface FakeExtensionOptions {
    readonly manifest: FakeManifest;
    // Answers a daemon call the extension's reach admits. Absent, or answering undefined: 404, as for a route that is
    // not there.
    readonly daemon?: (request: Request) => Response | undefined | Promise<Response | undefined>;
    readonly settings?: ExtensionSettingValues;
    // Answers a command run through `api.exec` whose class the manifest declares; absent, every command exits 0 having
    // printed nothing.
    readonly exec?: (command: ExtensionExec) => ExtensionExecResult | Promise<ExtensionExecResult>;
    // (2026-11-26) What the turn calling a tool holds, unless `callTool`'s context names its own: nothing when absent.
    readonly grants?: ToolCallGrants;
    // (2026-11-26) Answers a call through `api.browser.call` the manifest declares and the call's grants admit, as the
    // turn's browser router would; absent, an empty result. A tool outside the page tools the daemon admits, and a
    // navigation off the account's sites, are refused before it is asked, as the daemon refuses them.
    readonly browser?: (call: FakeBrowserCall) => ToolResult | Promise<ToolResult>;
    // (2026-11-26) Answers a call through `api.ownerBrowser.call` the manifest declares and the grants admit; absent, an
    // empty result.
    readonly ownerBrowser?: (call: FakeOwnerBrowserCall) => ToolResult | Promise<ToolResult>;
    // Each a fresh temp directory when absent, removed again by `dispose`.
    readonly workspaceRoot?: string;
    readonly extensionDir?: string;
    readonly stateDir?: string;
    readonly cacheDir?: string;
}

// (2026-11-26) A call that reached the turn's browser (`api.browser.call`), as the daemon was asked and admitted it.
export interface FakeBrowserCall {
    readonly account: string;
    readonly tool: string;
    readonly args: ToolArguments;
    readonly conversationId?: string | undefined;
}

// (2026-11-26) A call that reached the owner's browser (`api.ownerBrowser.call`).
export interface FakeOwnerBrowserCall {
    readonly browser: string;
    readonly tool: string;
    readonly args: ToolArguments;
    readonly conversationId?: string | undefined;
}

// (2026-11-26) A job a tool started (`api.jobs.start`), as the daemon filed it: what it showed while it ran, its end once
// its work told it, and whether it was stopped.
export interface FakeJob {
    readonly id: string;
    readonly conversationId: string;
    readonly command: string;
    readonly description: string;
    readonly lane?: { readonly name: string; readonly key?: string | undefined; readonly most?: number | undefined } | undefined;
    readonly lines: readonly string[];
    readonly end?: JobEnd | undefined;
    readonly stopped: boolean;
}

// One request the extension sent the daemon, whether its reach admitted it, and the caller it carried an assertion of
// (`api.daemon.asCaller`), as the daemon would believe it.
export interface FakeDaemonCall {
    readonly line: string;
    readonly admitted: boolean;
    readonly caller?: ExtensionCallerWho | undefined;
}

export interface FakeExtension {
    readonly api: ExtensionServerApi;
    readonly calls: readonly FakeDaemonCall[];
    readonly logs: readonly string[];
    // The labels of the work it holds now (`api.work.hold`), as the daemon counts them.
    readonly holds: readonly string[];
    // Every command it ran through `api.exec`, as the daemon was asked.
    readonly execs: readonly ExtensionExec[];
    // (2026-11-26) Every call that reached the turn's browser and the owner's, and every job its tools started.
    readonly browserCalls: readonly FakeBrowserCall[];
    readonly ownerBrowserCalls: readonly FakeOwnerBrowserCall[];
    readonly jobs: readonly FakeJob[];
    // (2026-11-26) The job's end once its work told it, as `wait` hands it to the agent.
    jobEnd(id: string): Promise<JobEnd>;
    // (2026-11-26) The agent or a person stopping the job: its work's signal aborts.
    stopJob(id: string): void;
    // Activates a server module as the backend host does, keeping what it hands back for `deactivate` and `health`.
    activate(module: Partial<ExtensionServerModule> & { default?: ExtensionServerModule }): Promise<void>;
    // A request into the extension's own /x namespace, `path` relative to it, as the daemon's proxy delivers it: with an
    // assertion of `options.caller` (a person signed in when absent, the owner), which `api.caller` reads.
    route(path: string, init?: RequestInit, options?: FakeRouteOptions): Promise<Response>;
    // A call through one of its public routes (`contributes.publicRoutes`), `path` relative to /door/<id>, as the daemon's
    // door delivers it once its protections passed: rejects for a method and path no declared route answers, which the
    // daemon answers 404 without the backend hearing of it. `verified` fills in or overrides what the door checked.
    publicRoute(path: string, init?: RequestInit, verified?: Partial<PublicRouteVerification>): Promise<Response>;
    // The tools it serves a card (undefined: the extension-level server), and one call to one of them.
    tools(card?: ToolCard): Promise<readonly ToolDefinition[]>;
    // Answers whatever the tool's own `call` answers, as ToolDefinition declares it; the host turns that into what the
    // model reads. (2026-11-26) The call is handed `grants` (the context's, else the options', else none) and a ticket
    // good while it runs, as the daemon's door hands them.
    callTool(name: string, args?: ToolArguments, card?: ToolCard, context?: Partial<ToolCallContext>): ReturnType<ToolDefinition["call"]>;
    // An approved action handed over as the daemon's approvals executor hands it, through the host's door.
    perform(action: ApprovedAction, signal?: AbortSignal): Promise<ApprovedActionOutcome>;
    // (2026-11-26) An approved post handed over as the daemon's approvals executor hands it, through the host's door:
    // rejects when the backend publishes no posts (`api.approvals.publish`). The rest of the post is filled in.
    publish(post: Pick<ApprovedPost, "platform" | "content" | "target"> & Partial<ApprovedPost>, signal?: AbortSignal): Promise<ApprovedActionOutcome>;
    // An automation's fire handed to the handler it names, as the daemon's automations engine hands it through the host's
    // door; the rest of the fire is filled in. Rejects when no handler of that name is registered, which the daemon reads
    // as "not yet" and tries again later.
    fire(handler: string, fire?: Partial<Omit<AutomationFire, "handler">>): Promise<void>;
    // A watch's check handed to the handler served for its kind, as the daemon's automations engine hands it through the
    // host's door; the rest of the check is filled in. Rejects when nothing serves the kind, which the daemon says on the
    // automation's run as a check that could not run.
    check(kind: string, check?: Partial<Omit<WatchCheck, "kind">>, signal?: AbortSignal): Promise<WatchCheckAnswer>;
    // The owner changing its settings: stored, and told to the extension over its event stream as the daemon would.
    setSettings(values: ExtensionSettingValues): void;
    // A frame on its event stream, as the daemon sends it (`files`, `refs`, `repos`, `settings`, and `run` and `activity`,
    // which reach a stream only when the manifest declares them).
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

// The owner, signed in: who a fake request into /x comes from unless the test says otherwise.
const OWNER: ExtensionCallerIdentity = { kind: "person", email: "owner@example.com", tier: "owner" };

// A caller's assertion as the daemon's proxy mints it, signed with the fake's own word in place of the daemon's key: the
// fake daemon believes only those it minted.
const fakeAssertion = (claim: ExtensionCallerClaim): string => `${Buffer.from(JSON.stringify(claim), "utf8").toString("base64url")}.fake-daemon-signature`;

// A caller as the assertion's claim spells it: a person's lists copied, every other kind as it is.
const claimOf = (caller: NonNullable<FakeRouteOptions["caller"]>): ExtensionCallerIdentity => {
    if (caller.kind !== "person") {
        return { ...caller };
    }
    const { areas, folders, manages, ...person } = caller;
    const claim: ExtensionCallerIdentity = { ...person };
    if (areas !== undefined) {
        claim.areas = [...areas];
    }
    if (folders !== undefined) {
        claim.folders = [...folders];
    }
    if (manages !== undefined) {
        claim.manages = [...manages];
    }
    return claim;
};

// Who an assertion the fake daemon believed says is calling, without the folders only the backend reads.
const callerWho = (claim: ExtensionCallerClaim | undefined): ExtensionCallerWho | undefined => {
    if (claim === undefined) {
        return undefined;
    }
    const { folders: _folders, ...who } = claim.caller.kind === "person" ? claim.caller : { ...claim.caller, folders: undefined };
    return who;
};

// ---- the turn a tool's call stands on (2026-11-26) ------------------------------------------------------------------

// What a ticket stands for: the grants of the call it was minted for, its conversation, and the job it is, if one.
interface FakeStanding {
    readonly grants: ToolCallGrants;
    readonly conversationId?: string | undefined;
    readonly job?: string | undefined;
}

// A host as an account's site is matched: lowercased, `www.` dropped; a site's subdomain is on it.
const onSites = (url: string, sites: readonly string[]): boolean => {
    const host = URL.parse(url)?.hostname.toLowerCase().replace(/^www\./u, "");
    return host !== undefined && host !== "" && sites.some((site) => host === site || host.endsWith(`.${site}`));
};

const EMPTY_RESULT: ToolResult = { content: [] };
const BROWSER_TOOLS: ReadonlySet<string> = new Set(EXTENSION_BROWSER_TOOLS);

// A job as the fake daemon runs it: its record, its stream's controller, and who waits on its end.
interface RunningFakeJob {
    record: FakeJob;
    readonly stream: ReadableStreamDefaultController<Uint8Array>;
    readonly ended: PromiseWithResolvers<JobEnd>;
}

// The url a navigation names, when it names one.
const navigationUrl = (args: ToolArguments | undefined): string | undefined => ExtensionNavigateArgumentsSchema.safeParse(args).data?.url;

// The daemon's turn doors, judged as it judges them (extensions/turn/tool-turn-doors.ts): the declared power, a live
// ticket, the grants it stands for, and for an account's browser the page tools and the account's sites; a job filed in
// the call's conversation, begun at once (no lane waits here), its lines and end kept.
const fakeTurn = (options: FakeExtensionOptions, declared: readonly string[]) => {
    const tickets = new Map<string, FakeStanding>();
    const browserCalls: FakeBrowserCall[] = [];
    const ownerBrowserCalls: FakeOwnerBrowserCall[] = [];
    const jobs = new Map<string, RunningFakeJob>();
    const encoder = new TextEncoder();
    let minted = 0;
    const mint = (standing: FakeStanding) => {
        minted += 1;
        const ticket = `fake-ticket-${minted}`;
        tickets.set(ticket, standing);
        return { ticket, release: () => void tickets.delete(ticket) };
    };
    // The standing behind a request, or the refusal the daemon answers with.
    const standingOf = (power: string, ticket: string): FakeStanding | Response => {
        if (!declared.includes(power)) {
            return json({ error: `"${power}" is not declared in permissions.turn` }, 403);
        }
        return tickets.get(ticket) ?? json({ error: "no call of this extension's tools, nor a job one started, is running under that ticket" }, 403);
    };
    const browserCall = async (request: Request): Promise<Response> => {
        const asked = ExtensionBrowserCallSchema.parse(await request.json());
        const standing = standingOf("browser", asked.turn);
        if (standing instanceof Response) {
            return standing;
        }
        const account = standing.grants.accounts.find((held) => held.id === asked.account);
        if (account === undefined) {
            return json({ error: `the turn that made this call holds no account "${asked.account}"` }, 403);
        }
        if (!BROWSER_TOOLS.has(asked.tool)) {
            return json({ error: `${asked.tool} is not a browser tool an extension may call` }, 403);
        }
        const url = navigationUrl(asked.arguments);
        if (asked.tool === "browser_navigate" && (url === undefined || !onSites(url, account.sites))) {
            return json({ error: `account "${account.id}" signs in on ${account.sites.join(" or ")}; that url is not on them` }, 403);
        }
        const call: FakeBrowserCall = { account: account.id, tool: asked.tool, args: asked.arguments ?? {}, conversationId: standing.conversationId };
        browserCalls.push(call);
        return json({ result: (await options.browser?.(call)) ?? EMPTY_RESULT });
    };
    const ownerBrowserCall = async (request: Request): Promise<Response> => {
        const asked = ExtensionOwnerBrowserCallSchema.parse(await request.json());
        const standing = standingOf("owner-browser", asked.turn);
        if (standing instanceof Response) {
            return standing;
        }
        if (!standing.grants.browsers.includes(asked.browser)) {
            return json({ error: `the turn that made this call holds no browser of the owner's called "${asked.browser}"` }, 403);
        }
        const call: FakeOwnerBrowserCall = { browser: asked.browser, tool: asked.tool, args: asked.arguments ?? {}, conversationId: standing.conversationId };
        ownerBrowserCalls.push(call);
        return json({ result: (await options.ownerBrowser?.(call)) ?? EMPTY_RESULT });
    };
    const frame = (job: RunningFakeJob, body: Readonly<Record<string, string | number>>): void => {
        try {
            job.stream.enqueue(encoder.encode(`${JSON.stringify(body)}\n`));
        } catch {
            // allow(silent-catch): a stream the extension already let go of takes no more frames
        }
    };
    const close = (job: RunningFakeJob): void => {
        try {
            job.stream.close();
        } catch {
            // allow(silent-catch): already closed by the extension's side, which is the state being reached
        }
    };
    const startJob = async (request: Request): Promise<Response> => {
        const asked = ExtensionJobStartSchema.parse(await request.json());
        const standing = standingOf("jobs", asked.turn);
        if (standing instanceof Response) {
            return standing;
        }
        if (standing.conversationId === undefined) {
            return json({ error: "the turn that made this call has no conversation to file a job in" }, 409);
        }
        const id = `job-${jobs.size + 1}`;
        const ticket = mint({ ...standing, job: id });
        const record: FakeJob = { id, conversationId: standing.conversationId, command: asked.command, description: asked.description, lane: asked.lane, lines: [], stopped: false };
        const body = new ReadableStream<Uint8Array>({
            start: (stream) => {
                const job: RunningFakeJob = { record, stream, ended: Promise.withResolvers<JobEnd>() };
                jobs.set(id, job);
                void job.ended.promise.then(() => ticket.release());
                frame(job, { kind: "filed", id, job: ticket.ticket, ahead: 0 });
                frame(job, { kind: "begin" });
            },
        });
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    };
    const reportJob = async (request: Request, id: string): Promise<Response> => {
        const asked = ExtensionJobReportSchema.parse(await request.json());
        const standing = standingOf("jobs", asked.job);
        const job = jobs.get(id);
        if (standing instanceof Response || standing.job !== id || job === undefined) {
            return json({ error: `no job "${id}" of this extension is running under that ticket` }, 404);
        }
        if (asked.say !== undefined) {
            job.record = { ...job.record, lines: [...job.record.lines, asked.say] };
        }
        if (asked.end !== undefined && job.record.end === undefined) {
            job.record = { ...job.record, end: asked.end };
            job.ended.resolve(asked.end);
            close(job);
        }
        return json({ ok: true });
    };
    const jobsPath = extensionJobsUrl();
    return {
        mint,
        browserCalls,
        ownerBrowserCalls,
        jobs: (): FakeJob[] => [...jobs.values()].map((job) => job.record),
        door: async (request: Request, url: URL): Promise<Response | undefined> => {
            if (url.pathname === extensionBrowserUrl()) {
                return await browserCall(request);
            }
            if (url.pathname === extensionOwnerBrowserUrl()) {
                return await ownerBrowserCall(request);
            }
            if (url.pathname === jobsPath) {
                return await startJob(request);
            }
            return url.pathname.startsWith(`${jobsPath}/`) ? await reportJob(request, decodeURIComponent(url.pathname.slice(jobsPath.length + 1))) : undefined;
        },
        jobEnd: async (id: string): Promise<JobEnd> => {
            const job = jobs.get(id);
            if (job === undefined) {
                throw new Error(`no job "${id}" was started`);
            }
            return await job.ended.promise;
        },
        stopJob: (id: string): void => {
            const job = jobs.get(id);
            if (job === undefined || job.record.end !== undefined) {
                return;
            }
            const end: JobEnd = { ok: false, output: "stopped" };
            job.record = { ...job.record, stopped: true, end };
            frame(job, { kind: "stopped" });
            job.ended.resolve(end);
            close(job);
        },
    };
};

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
    const declared = declaredReachOf(options.manifest.permissions);
    const calls: FakeDaemonCall[] = [];
    const logs: string[] = [];
    const holds = new Map<symbol, string>();
    const execs: ExtensionExec[] = [];
    const turn = fakeTurn(options, declared.turn);
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

    // A hold stands while its answer is open, as the daemon's does: a heartbeat at once, then nothing until let go.
    const holdStream = (label: string, signal: AbortSignal | null): Response => {
        const key = Symbol(label);
        holds.set(key, label);
        const release = (): void => void holds.delete(key);
        signal?.addEventListener("abort", release);
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(encoder.encode(`${JSON.stringify({ kind: "heartbeat" })}\n`)),
            cancel: release,
        });
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    };

    // The extension's own doors, judged by what its manifest declares as the daemon judges them (own.routes.ts,
    // own-doors.ts); undefined for a request that is for none of them.
    const ownDoor = async (request: Request, url: URL, signal: AbortSignal | null): Promise<Response | undefined> => {
        if (request.method === "GET" && url.pathname === extensionSettingsUrl()) {
            return json({ settings });
        }
        if (request.method === "GET" && url.pathname === extensionEventsUrl()) {
            const asked = (url.searchParams.get(EXTENSION_EVENTS_KINDS_PARAM) ?? "").split(",").filter((kind) => kind !== "");
            const refused = asked.find((kind) => !declared.events.some((each) => each === kind));
            return refused === undefined ? eventStream(signal) : json({ error: `the event kind "${refused}" is not declared in permissions.events` }, 403);
        }
        if (request.method === "POST" && url.pathname === extensionWorkHoldUrl()) {
            const hold = ExtensionWorkHoldSchema.safeParse(await request.json());
            if (!declared.work || !hold.success) {
                return json({ error: declared.work ? "a hold carries { label }" : "permissions.work is not declared" }, declared.work ? 400 : 403);
            }
            return holdStream(hold.data.label, signal);
        }
        if (request.method === "POST" && url.pathname === extensionExecUrl()) {
            const command = ExtensionExecSchema.parse(await request.json());
            if (!declared.exec.includes(command.class)) {
                return json({ error: `the workload class "${command.class}" is not declared in permissions.exec` }, 403);
            }
            execs.push(command);
            return json((await options.exec?.(command)) ?? { waitedMs: 0, exitCode: 0, stdout: "", stderr: "", truncated: false });
        }
        return request.method === "POST" ? await turn.door(request, url) : undefined;
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
    // The assertions minted for this extension's requests, which alone the fake daemon believes, as the daemon believes
    // only its own key's.
    const minted = new Set<string>();
    const believed = (assertion: string | null): ExtensionCallerClaim | "refused" | undefined => {
        if (assertion === null || assertion === "") {
            return undefined;
        }
        const claim = readCallerClaim(assertion);
        return claim === undefined || !minted.has(assertion) || claim.extension !== id || Date.now() >= claim.expiresAt ? "refused" : claim;
    };

    const daemon = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const line = `${request.method} ${url.pathname}`;
        if (request.headers.get(EXTENSION_TOKEN_HEADER) !== TOKEN) {
            calls.push({ line, admitted: false });
            return json({ error: "unauthorized" }, 401);
        }
        const admitted = extensionRouteReach(reach, request.method, url.pathname);
        const claim = believed(request.headers.get(EXTENSION_CALLER_HEADER));
        if (claim === "refused") {
            calls.push({ line, admitted: false });
            return json({ error: "the caller assertion was not minted for this extension by this daemon, or is past its window" }, 401);
        }
        calls.push({ line, admitted, caller: callerWho(claim) });
        if (!admitted) {
            return json({ error: "extension token not valid for this route" }, 403);
        }
        return (await ownDoor(request, url, init?.signal ?? null)) ?? (await options.daemon?.(request)) ?? json({ error: "not found" }, 404);
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
        declared,
        watchKinds: (options.manifest.contributes?.watchKinds ?? []).map((kind) => kind.id),
    });
    let activation: ServerActivation = {};

    return {
        api: slots.api,
        calls,
        logs,
        get holds() {
            return [...holds.values()];
        },
        execs,
        browserCalls: turn.browserCalls,
        ownerBrowserCalls: turn.ownerBrowserCalls,
        get jobs() {
            return turn.jobs();
        },
        jobEnd: turn.jobEnd,
        stopJob: turn.stopJob,
        activate: async (module) => {
            activation = await activateServerModule(module, slots.api, { extensionId: id });
        },
        route: async (path, init, routeOptions = {}) => {
            const handler = slots.handler();
            if (handler === undefined) {
                return json({ error: `the "${id}" backend serves no routes` }, 404);
            }
            const issuedAt = Date.now() - (routeOptions.mintedAgoMs ?? 0);
            const assertion = fakeAssertion({
                v: 1,
                sandbox: "fake",
                extension: id,
                issuedAt,
                expiresAt: issuedAt + EXTENSION_CALLER_TTL_MS,
                nonce: `${minted.size}`,
                caller: claimOf(routeOptions.caller ?? OWNER),
            });
            minted.add(assertion);
            const headers = new Headers(init?.headers);
            headers.set(EXTENSION_CALLER_HEADER, assertion);
            return (await handler(new Request(new URL(path, "http://extension.internal"), { ...init, headers }))) ?? json({ error: "not found" }, 404);
        },
        publicRoute: async (path, init, verified = {}) => {
            const handler = slots.publicHandler();
            if (handler === undefined) {
                throw new Error(`"${id}" serves no public routes`);
            }
            const url = new URL(path, "http://extension.internal");
            const segments = url.pathname.split("/").filter((segment) => segment !== "");
            const method = init?.method ?? "GET";
            const landed = publicRouteFor(options.manifest.contributes?.publicRoutes ?? [], method, segments);
            if (landed === undefined) {
                throw new Error(`"${id}" declares no public route answering ${method} ${url.pathname}: the daemon answers 404 before the backend hears of it`);
            }
            const verification: PublicRouteVerification = { route: landed.path, at: Date.now(), automationId: publicRouteAutomationOf(landed, segments), ...verified };
            return (await handler(new Request(url, init), verification)) ?? json({ error: "not found" }, 404);
        },
        tools: async (card) => (await slots.tools()?.(card)) ?? [],
        callTool: async (name, args = {}, card, context = {}) => {
            const tool = ((await slots.tools()?.(card)) ?? []).find((each) => each.name === name);
            if (tool === undefined) {
                throw new Error(`"${id}" serves no tool named ${name}${card === undefined ? "" : ` for card ${card.id}`}`);
            }
            const grants = context.grants ?? options.grants ?? NO_TOOL_GRANTS;
            const standing = turn.mint({ grants, conversationId: context.conversationId });
            try {
                return await tool.call(args, { signal: context.signal ?? new AbortController().signal, conversationId: context.conversationId, grants, ticket: standing.ticket });
            } finally {
                standing.release();
            }
        },
        perform: async (action, signal = new AbortController().signal) => {
            const performer = slots.performer();
            if (performer === undefined) {
                throw new Error(`"${id}" carries out no approved actions`);
            }
            return performer(action, { signal });
        },
        publish: async (post, signal = new AbortController().signal) => {
            const publisher = slots.publisher();
            if (publisher === undefined) {
                throw new Error(`"${id}" publishes no approved posts`);
            }
            return publisher({ id: `post-${Date.now()}`, approvedAt: Date.now(), actionRules: {}, ...post }, { signal });
        },
        fire: async (handler, fire = {}) => {
            const listener = slots.fireHandler(handler);
            if (listener === undefined) {
                throw new Error(`"${id}" has registered no "${handler}" fire handler`);
            }
            await listener(
                { id: fire.id ?? `fire-${Date.now()}`, automationId: fire.automationId ?? "test-automation", firedAt: fire.firedAt ?? Date.now(), coalesced: fire.coalesced ?? 0, prompt: fire.prompt ?? "", payload: fire.payload, observed: fire.observed, handler },
                { signal: new AbortController().signal },
            );
        },
        check: async (kind, check = {}, signal = new AbortController().signal) => {
            const handler = slots.checkHandler(kind);
            if (handler === undefined) {
                throw new Error(`"${id}" serves no "${kind}" watch kind`);
            }
            return handler({ kind, params: check.params ?? {}, last: check.last, reach: check.reach ?? {}, automationId: check.automationId }, { signal });
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
