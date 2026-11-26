import { randomUUID } from "node:crypto";
import { anySignal, whenAborted } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { declaredReachOf, type ExtensionTurnPower } from "@intentic/extension-manifest";
import {
    EXTENSION_EVENTS_HEARTBEAT_MS,
    ExtensionBrowserCallSchema,
    type ExtensionJobFrame,
    ExtensionJobReportSchema,
    ExtensionJobStartSchema,
    ExtensionOwnerBrowserCallSchema,
    type ExtensionToolResult,
    ExtensionToolResultSchema,
} from "@intentic/sandbox-contract/extension-protocol";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { BackgroundJob, BackgroundJobSeed } from "../../agent/tools/jobs/background-jobs.js";
import type { DaemonJobEnd, DaemonJobSpec, RunningDaemonJob } from "../../agent/tools/jobs/daemon/daemon-jobs.js";
import type { JobLanes, LaneRelease } from "../../agent/tools/jobs/daemon/job-lanes.js";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import type { MountEndpoints } from "../../agent/tools/turn-mounts.routes.js";
import { ROUTED_BROWSER_SERVER } from "../../browser/tools/browser-servers.js";
import type { InstalledExtension } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import type { TurnTicket, TurnTickets } from "./tool-grants.js";
import { scopedBrowserCall } from "./turn-browser.js";

/* THE DOORS AN EXTENSION TOOL'S CALL OPENS ONTO ITS TURN (2026-11-26, extension API 2.55.0). Each is reached by an
   extension's own token undeclared in `permissions.daemon` (extension-manifest's EXTENSION_OWN_ROUTES), answers only a
   ticket the daemon minted for that same extension's tool call or a job that call started (tool-grants.ts), and only
   for a power its manifest declares under `permissions.turn`:
   - `browser` (POST /extension/turn/browser): the turn's own signed-in browser router, for an account the turn holds, on
     that account's own sites (turn-browser.ts).
   - `owner-browser` (POST /extension/turn/owner-browser): the owner's own browser the turn holds, through the peer door
     the agent's own calls take (webext/webext-peer.ts), where that browser's site switches and asks apply.
   - `jobs` (POST /extension/jobs, POST /extension/jobs/{id}): a background job filed in the calling conversation like a
     `run_in_background` command's (daemon-jobs.ts), waiting its turn in a lane of the extension's own (job-lanes.ts),
     while the extension's backend does the work and reports its lines and its end; the agent collects it with `wait`,
     and a turn that ended on it is woken by its end. The backend letting go of the job's stream ends the job as failed.
   Whatever comes back is masked: a stored secret's value goes back as its reference, as the MCP door masks it. */

// Far above any page step or any file a tool sends a page; a bound on what one request makes the daemon hold.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export interface TurnDoorDeps {
    readonly tickets: TurnTickets;
    // The calling extension, from its token (own.routes.ts ownCaller), or the refusal to answer with.
    readonly caller: (c: Context<AppEnv>) => Promise<InstalledExtension | Response>;
    readonly capabilities: Pick<Services["capabilities"], "get">;
    // Every stored secret's value masked to its reference.
    readonly mask: <T>(value: T) => Promise<T>;
    // The owner's-browser door the agent's own calls go through.
    readonly ownerBrowser: MountEndpoints["webext"];
    // The seed a conversation's job is filed with; undefined for a conversation the registry does not know.
    readonly seedOf: (conversationId: string) => BackgroundJobSeed | undefined;
    // The daemon's own jobs (agent/tools/jobs/daemon/daemon-jobs.ts startDaemonJob, job-lanes.ts createJobLanes), handed
    // in from above, since this layer sits under the agent's.
    readonly startJob: (seed: BackgroundJobSeed, spec: DaemonJobSpec) => BackgroundJob | undefined;
    readonly jobLanes: (most: number) => JobLanes;
}

// A request's standing: the extension, its ticket's, and what it asked.
interface Standing<T> {
    readonly extension: InstalledExtension;
    readonly ticket: TurnTicket;
    readonly asked: T;
}

const refused = (c: Context<AppEnv>, error: string, status: 400 | 403 | 404 | 409 | 413 | 503 = 403): Response => c.json({ error }, status);

const POWER_WORDS = {
    browser: "drive no account's browser",
    "owner-browser": "reach no browser of the owner's",
    jobs: "start no background jobs",
} as const satisfies Record<ExtensionTurnPower, string>;

// The caller, its body read by `schema`, its ticket read and held to the caller and the declared power; or the refusal.
const standingOf = async <S extends z.ZodType<{ readonly turn?: string; readonly job?: string }>>(
    deps: TurnDoorDeps,
    c: Context<AppEnv>,
    power: ExtensionTurnPower,
    schema: S,
): Promise<Standing<z.output<S>> | Response> => {
    const extension = await deps.caller(c);
    if (extension instanceof Response) {
        return extension;
    }
    if (!declaredReachOf(extension.manifest.permissions).turn.includes(power)) {
        return refused(c, `extension "${extension.id}" did not declare "${power}" in permissions.turn, so its tools ${POWER_WORDS[power]}`);
    }
    const body = await readBoundedJson(c.req.raw, MAX_REQUEST_BYTES);
    if (body.kind === "tooLarge") {
        return refused(c, `a request here carries ${MAX_REQUEST_BYTES / 1024 / 1024} MiB at most`, 413);
    }
    const asked = schema.safeParse(body.kind === "ok" ? body.value : undefined);
    if (!asked.success) {
        return refused(c, `not a request this door reads: ${asked.error.issues[0]?.message ?? "the body does not parse"}`, 400);
    }
    const presented = asked.data.turn ?? asked.data.job ?? "";
    const ticket = deps.tickets.read(presented);
    // One minted for another extension reads as none at all: nothing says whose it was.
    if (ticket === undefined || ticket.extension !== extension.id) {
        return refused(c, "no call of this extension's tools, nor a job one started, is running under that ticket: it ended, or was never this extension's");
    }
    return { extension, ticket, asked: asked.data };
};

const ErrorWordsSchema = z.looseObject({ message: z.string() });

// A peer's answer as the tool result a reader of a result reads; a JSON-RPC error becomes its words.
const resultOf = (answer: RpcMessage | undefined): ExtensionToolResult => {
    const result = ExtensionToolResultSchema.safeParse(answer?.result);
    if (result.success) {
        return result.data;
    }
    const words = ErrorWordsSchema.safeParse(answer?.error).data?.message ?? "the browser gave no answer";
    return { content: [{ type: "text", text: words }], isError: true };
};

const heldNames = (names: readonly string[]): string => (names.length === 0 ? "none" : names.map((name) => `"${name}"`).join(", "));

// (2026-11-26) A call that may take minutes answered as it comes: its status and headers at once, a space on the events'
// beat, then its JSON, which leading whitespace leaves as it was. The backend host reaches this door with Node's fetch,
// which gives up on an answer whose headers have not come in five minutes (undici's headersTimeout) and on a body silent
// as long; one ChatGPT image in the owner's browser takes nine. A failure past the headers answers as the result's error.
const answeredAsItComes = (c: Context<AppEnv>, answer: () => Promise<ExtensionToolResult>): Response => {
    c.header("content-type", "application/json");
    return stream(c, async (out) => {
        // allow(silent-catch): the only failure is a reader that went away, whose call its own signal already ends.
        const beat = setInterval(() => void out.write(" ").catch(() => undefined), EXTENSION_EVENTS_HEARTBEAT_MS);
        let result: ExtensionToolResult;
        try {
            result = await answer();
        } catch (error) {
            result = { content: [{ type: "text", text: `The call failed: ${errorMessage(error)}` }], isError: true };
        } finally {
            clearInterval(beat);
        }
        await out.write(JSON.stringify({ result }));
    });
};

// ---- jobs -------------------------------------------------------------------------------------------------------

// What a job's stream says, held until the stream is open: its work may begin before the daemon has answered at all.
const frameQueue = () => {
    const held: ExtensionJobFrame[] = [];
    let write: ((frame: ExtensionJobFrame) => void) | undefined;
    return {
        push: (frame: ExtensionJobFrame): void => {
            if (write === undefined) {
                held.push(frame);
            } else {
                write(frame);
            }
        },
        // The `filed` frame first, then what came before the stream opened.
        open: (to: (frame: ExtensionJobFrame) => void, filed: ExtensionJobFrame): void => {
            to(filed);
            for (const frame of held.splice(0)) {
                to(frame);
            }
            write = to;
        },
    };
};

// A job of an extension's in flight: what its reports reach.
interface LiveJob {
    readonly extension: string;
    readonly say: (line: string) => void;
    readonly end: (end: DaemonJobEnd) => void;
}

const NO_LANE: LaneRelease = () => undefined;

// What the job's work came to, or the end standing for it when the backend let go of the job first.
const workEnd = async (reported: Promise<DaemonJobEnd>, gone: AbortSignal): Promise<DaemonJobEnd> =>
    await Promise.race([
        reported,
        new Promise<DaemonJobEnd>((resolve) =>
            whenAborted(gone, () =>
                resolve({ ok: false, output: "The extension's backend let go of this job before it ended (it restarted, or stopped): its work may not have finished." }),
            ),
        ),
    ]);

type Door = (c: Context<AppEnv>) => Promise<Response>;

// POST /extension/turn/browser: the turn's own signed-in browser, for an account it holds, on that account's sites.
const browserDoor =
    (deps: TurnDoorDeps): Door =>
    async (c) => {
        const standing = await standingOf(deps, c, "browser", ExtensionBrowserCallSchema);
        if (standing instanceof Response) {
            return standing;
        }
        const { ticket, asked } = standing;
        const account = ticket.grants.accounts.find((held) => held.id === asked.account);
        if (account === undefined) {
            return refused(c, `the turn that made this call holds no account "${asked.account}"; it holds ${heldNames(ticket.grants.accounts.map((held) => held.id))}`);
        }
        const mounted = ticket.turn?.mounted().get(ROUTED_BROWSER_SERVER);
        if (mounted?.kind !== "browser") {
            return refused(c, "the turn that made this call holds no signed-in browser now: it has ended, or this sandbox has no browser installed", 409);
        }
        const answer = await scopedBrowserCall(mounted.router, account, { tool: asked.tool, args: asked.arguments ?? {} }, c.req.raw.signal);
        if ("refusal" in answer) {
            return refused(c, answer.refusal, answer.withheld === true ? 409 : 403);
        }
        return c.json({ result: await deps.mask(answer.result) });
    };

// POST /extension/turn/owner-browser: the owner's own browser the turn holds, through its peer door.
const ownerBrowserDoor =
    (deps: TurnDoorDeps): Door =>
    async (c) => {
        const standing = await standingOf(deps, c, "owner-browser", ExtensionOwnerBrowserCallSchema);
        if (standing instanceof Response) {
            return standing;
        }
        const { ticket, asked } = standing;
        if (!ticket.grants.browsers.includes(asked.browser)) {
            return refused(c, `the turn that made this call holds no browser of the owner's called "${asked.browser}"; it holds ${heldNames(ticket.grants.browsers)}`);
        }
        if ((await deps.capabilities.get(asked.browser))?.kind !== "webext") {
            return refused(c, `"${asked.browser}" is no longer one of the owner's connected browsers`);
        }
        const message: RpcMessage = { jsonrpc: "2.0", id: `extension-owner-browser-${randomUUID()}`, method: "tools/call", params: { name: asked.tool, arguments: asked.arguments ?? {} } };
        // The browser's own tools wait as long as a person's page takes (a ChatGPT image, nine minutes).
        return answeredAsItComes(c, async () => {
            const answer = await deps.ownerBrowser({ kind: "webext", id: asked.browser }, message, {
                name: asked.browser,
                conversationId: ticket.conversationId,
                signal: c.req.raw.signal,
            });
            return await deps.mask(resultOf(answer));
        });
    };

// A lane of the extension's own, by name; its `most` is the first start's.
interface ExtensionLane {
    readonly lanes: JobLanes;
    readonly name: string;
}

// The job's work as the daemon runs it: its turn in the lane, then the backend's report of its end, or the end standing
// for one when the job was stopped or the backend let go first.
const jobWork =
    (lane: ExtensionLane | undefined, key: string | undefined, frames: ReturnType<typeof frameQueue>, reported: Promise<DaemonJobEnd>, gone: AbortSignal) =>
    async (signal: AbortSignal): Promise<DaemonJobEnd> => {
        const release = lane === undefined ? NO_LANE : await lane.lanes.enter(lane.name, key, anySignal(signal, gone));
        if (release === undefined) {
            return { ok: false, output: "Ended before its turn came: nothing was done." };
        }
        frames.push({ kind: "begin" });
        const unwatch = whenAborted(signal, () => frames.push({ kind: "stopped" }));
        const end = await workEnd(reported, gone);
        unwatch();
        release(end.ok);
        return end;
    };

// The job's stream: `filed` first, then what its work said, a heartbeat on the events' beat, open until the job's work
// settled or the backend let go.
const jobStream = (c: Context<AppEnv>, frames: ReturnType<typeof frameQueue>, filed: ExtensionJobFrame, settled: Promise<void>, gone: AbortController): Response => {
    c.header("content-type", "application/x-ndjson");
    return stream(c, async (out) => {
        out.onAbort(() => gone.abort());
        let tail: Promise<unknown> = Promise.resolve();
        // allow(silent-catch): the only failure is a reader that went away, which `gone` already ends the job for.
        const write = (frame: ExtensionJobFrame): void => void (tail = tail.then(() => out.writeln(JSON.stringify(frame))).catch(() => undefined));
        frames.open(write, filed);
        const beat = setInterval(() => write({ kind: "heartbeat" }), EXTENSION_EVENTS_HEARTBEAT_MS);
        try {
            await Promise.race([settled, new Promise<void>((resolve) => whenAborted(gone.signal, resolve))]);
            await tail;
        } finally {
            clearInterval(beat);
        }
    });
};

// POST /extension/jobs and POST /extension/jobs/{id}: a job filed in the calling conversation, and its reports.
const jobDoors = (deps: TurnDoorDeps) => {
    const lanes = new Map<string, JobLanes>();
    const laneOf = (extension: string, lane: { readonly name: string; readonly most?: number | undefined }): ExtensionLane => {
        const name = `${extension}\u0000${lane.name}`;
        const known = lanes.get(name) ?? deps.jobLanes(lane.most ?? 1);
        lanes.set(name, known);
        return { lanes: known, name };
    };
    const live = new Map<string, LiveJob>();
    const start: Door = async (c) => {
        const standing = await standingOf(deps, c, "jobs", ExtensionJobStartSchema);
        if (standing instanceof Response) {
            return standing;
        }
        const { extension, ticket, asked } = standing;
        const seed = ticket.conversationId === undefined ? undefined : deps.seedOf(ticket.conversationId);
        if (seed === undefined) {
            return refused(c, "the turn that made this call has no conversation to file a job in, or wake when it ends: do the work in the call", 409);
        }
        const lane = asked.lane === undefined ? undefined : laneOf(extension.id, asked.lane);
        const ahead = lane === undefined ? 0 : lane.lanes.held(lane.name);
        const frames = frameQueue();
        const gone = new AbortController();
        const reported = Promise.withResolvers<DaemonJobEnd>();
        const settled = Promise.withResolvers<void>();
        let running: RunningDaemonJob | undefined;
        const work = jobWork(lane, asked.lane?.key, frames, reported.promise, gone.signal);
        const filed = deps.startJob(seed, {
            command: asked.command,
            description: asked.description,
            started: asked.started,
            run: async (signal, job) => {
                running = job;
                try {
                    const end = await work(signal);
                    return { ...end, output: await deps.mask(end.output) };
                } finally {
                    settled.resolve();
                }
            },
        });
        if (filed === undefined) {
            gone.abort();
            return refused(c, "the job could not be filed (no room for its files): do the work in the call", 503);
        }
        const minted = deps.tickets.mint({ ...ticket, job: filed.id });
        live.set(filed.id, {
            extension: extension.id,
            say: (line) =>
                void deps.mask(line).then(
                    (masked) => running?.say(masked),
                    // A line that cannot be masked is not shown: the secrets it may hold could not be read to hide them.
                    () => running?.say("[a line was left out: the sandbox's secrets could not be read to mask it]"),
                ),
            end: (end) => reported.resolve(end),
        });
        void settled.promise.then(() => {
            minted.release();
            live.delete(filed.id);
        });
        return jobStream(c, frames, { kind: "filed", id: filed.id, job: minted.ticket, ahead }, settled.promise, gone);
    };
    const report: Door = async (c) => {
        const standing = await standingOf(deps, c, "jobs", ExtensionJobReportSchema);
        if (standing instanceof Response) {
            return standing;
        }
        const id = c.req.param("id") ?? "";
        const job = live.get(id);
        if (standing.ticket.job !== id || job === undefined || job.extension !== standing.extension.id) {
            return refused(c, `no job "${id}" of this extension is running under that ticket: it ended, was stopped, or is another's`, 404);
        }
        if (standing.asked.say !== undefined) {
            job.say(standing.asked.say);
        }
        if (standing.asked.end !== undefined) {
            job.end(standing.asked.end);
        }
        return c.json({ ok: true });
    };
    return { start, report };
};

export const createTurnDoors = (deps: TurnDoorDeps) => {
    const jobs = jobDoors(deps);
    return {
        "POST /extension/turn/browser": browserDoor(deps),
        "POST /extension/turn/owner-browser": ownerBrowserDoor(deps),
        "POST /extension/jobs": jobs.start,
        "POST /extension/jobs/{id}": jobs.report,
    } as const;
};
