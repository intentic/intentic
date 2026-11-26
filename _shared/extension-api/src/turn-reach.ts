import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import type { ExtensionTurnPower } from "@intentic/extension-manifest/permissions";
import {
    type ExtensionBrowserCall,
    extensionBrowserUrl,
    type ExtensionJobFrame,
    ExtensionJobFrameSchema,
    type ExtensionJobReport,
    type ExtensionJobStart,
    extensionJobsUrl,
    extensionJobUrl,
    type ExtensionOwnerBrowserCall,
    extensionOwnerBrowserUrl,
    ExtensionToolContentSchema,
    ExtensionTurnCallAnswerSchema,
    ExtensionTurnRefusalSchema,
    NO_TOOL_GRANTS,
} from "@intentic/sandbox-contract/extension-protocol";
import type { ExtensionServerApi, JobEnd, JobSpec, RunningJob, StartedJob, ToolContent, ToolResult, TurnStanding } from "./server.js";

// (2026-11-26) What an extension's agent tools do with the grants of the turn calling them (`api.browser`,
// `api.ownerBrowser`, `api.jobs`), over the daemon's turn doors: each refused here before anything is sent when the
// manifest does not declare it in `permissions.turn`, or when the call carries no ticket, and refused by the daemon for
// anything the turn does not hold. The backend host only: a process serves no tool through it, so it holds no ticket.

type DaemonRequest = ExtensionServerApi["daemon"]["request"];
type TurnReach = Pick<ExtensionServerApi, "browser" | "ownerBrowser" | "jobs">;

const NO_TICKET =
    "this call carries no ticket onto its turn: it did not come through the daemon's MCP door (a test calling the tool directly, or a daemon before 2.55.0)";

// What one of the doors is sent.
type TurnBody = ExtensionBrowserCall | ExtensionOwnerBrowserCall | ExtensionJobStart | ExtensionJobReport;

// The daemon's own words for a refusal: its `{ error }`, else the body's first line.
const refusalOf = async (answer: Response): Promise<string> => {
    const text = await answer.text();
    return parseJsonWith(text, ExtensionTurnRefusalSchema)?.error ?? text.split("\n")[0]?.slice(0, 300) ?? `${answer.status}`;
};

// A result as a tool reads it: its text and image blocks; a block of any other kind is left out.
const toolResultOf = (raw: { readonly content: readonly unknown[]; readonly isError?: boolean | undefined }): ToolResult => {
    const content: ToolContent[] = raw.content.flatMap((block) => {
        const read = ExtensionToolContentSchema.safeParse(block);
        return read.success ? [read.data] : [];
    });
    return raw.isError === true ? { content, isError: true } : { content };
};

export const createTurnReach = (id: string, request: DaemonRequest, declared: readonly ExtensionTurnPower[], log: (message: string) => void): TurnReach => {
    // The ticket the standing carries, once its power is declared; throws naming what is missing.
    const ticketFor = (power: ExtensionTurnPower, standing: TurnStanding): string => {
        if (!declared.includes(power)) {
            throw new Error(`extension "${id}" did not declare "${power}" in permissions.turn: add it to its manifest`);
        }
        if (standing.ticket === undefined || standing.ticket === "") {
            throw new Error(NO_TICKET);
        }
        return standing.ticket;
    };
    const post = (path: string, body: TurnBody, signal: AbortSignal | undefined): Promise<Response> => {
        const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
        if (signal !== undefined) {
            init.signal = signal;
        }
        return request(path, init);
    };
    // One turn call to its answer: the tool's result, or a rejection with the daemon's words.
    const callTurn = async (path: string, body: TurnBody, signal: AbortSignal | undefined): Promise<ToolResult> => {
        const answer = await post(path, body, signal);
        if (!answer.ok) {
            throw new Error(`the sandbox refused (${answer.status}): ${await refusalOf(answer)}`);
        }
        return toolResultOf(ExtensionTurnCallAnswerSchema.parse(await answer.json()).result);
    };
    return {
        browser: {
            call: async (standing, call) =>
                await callTurn(extensionBrowserUrl(), { turn: ticketFor("browser", standing), account: call.account, tool: call.tool, arguments: call.args ?? {} }, standing.signal),
        },
        ownerBrowser: {
            call: async (standing, call) =>
                await callTurn(
                    extensionOwnerBrowserUrl(),
                    { turn: ticketFor("owner-browser", standing), browser: call.browser, tool: call.tool, arguments: call.args ?? {} },
                    standing.signal,
                ),
        },
        jobs: {
            start: async (standing, spec) => await startJob({ id, post, log }, ticketFor("jobs", standing), standing, spec),
        },
    };
};

// ---- jobs -----------------------------------------------------------------------------------------------------------

interface JobDeps {
    readonly id: string;
    readonly post: (path: string, body: TurnBody, signal: AbortSignal | undefined) => Promise<Response>;
    readonly log: (message: string) => void;
}

type FiledFrame = Extract<ExtensionJobFrame, { readonly kind: "filed" }>;

// Every frame of the job's stream, in order, to its end.
async function* framesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<ExtensionJobFrame> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        const parts = (buffer + decoder.decode(chunk.value, { stream: true })).split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) {
            const frame = line.trim() === "" ? undefined : parseJsonWith(line, ExtensionJobFrameSchema);
            if (frame !== undefined) {
                yield frame;
            }
        }
    }
}

// The job's work, run once its turn came, its end told to the daemon; a throw ends it as failed with the message.
const runWork = async (deps: JobDeps, filed: FiledFrame, job: RunningJob, spec: JobSpec): Promise<void> => {
    let end: JobEnd;
    try {
        end = await spec.run(job);
    } catch (error) {
        end = { ok: false, output: `The job failed in extension "${deps.id}": ${errorMessage(error)}` };
    }
    await report(deps, filed, { end });
};

const report = async (deps: JobDeps, filed: FiledFrame, body: Omit<ExtensionJobReport, "job">): Promise<void> => {
    try {
        const answer = await deps.post(extensionJobUrl(filed.id), { job: filed.job, ...body }, undefined);
        if (!answer.ok) {
            deps.log(`job ${filed.id}: the sandbox did not take its ${body.end === undefined ? "line" : "end"} (${answer.status}): ${await refusalOf(answer)}`);
        }
    } catch (error) {
        deps.log(`job ${filed.id}: its ${body.end === undefined ? "line" : "end"} did not reach the sandbox: ${errorMessage(error)}`);
    }
};

// Files the job and answers once it is filed; the rest of its stream (its turn coming, a stop) is read on, and its
// work runs here, its lines and its end told to the daemon.
const startJob = async (deps: JobDeps, ticket: string, standing: TurnStanding, spec: JobSpec): Promise<StartedJob> => {
    const asked: ExtensionJobStart = { turn: ticket, command: spec.command, description: spec.description, started: spec.started };
    if (spec.lane !== undefined) {
        asked.lane = { name: spec.lane.name };
        if (spec.lane.key !== undefined) {
            asked.lane.key = spec.lane.key;
        }
        if (spec.lane.most !== undefined) {
            asked.lane.most = spec.lane.most;
        }
    }
    const answer = await deps.post(extensionJobsUrl(), asked, undefined);
    if (!answer.ok || answer.body === null) {
        throw new Error(`the sandbox refused (${answer.status}): ${await refusalOf(answer)}`);
    }
    const frames = framesOf(answer.body);
    const first = await frames.next();
    if (first.done === true || first.value.kind !== "filed") {
        throw new Error("the sandbox did not say the job was filed");
    }
    const filed = first.value;
    const stopped = new AbortController();
    let says: Promise<void> = Promise.resolve();
    const job: RunningJob = {
        id: filed.id,
        grants: standing.grants ?? NO_TOOL_GRANTS,
        ticket: filed.job,
        signal: stopped.signal,
        // In order, one at a time.
        say: (line) => void (says = says.then(() => report(deps, filed, { say: line }))),
    };
    void (async () => {
        let work: Promise<void> | undefined;
        try {
            for await (const frame of frames) {
                if (frame.kind === "begin") {
                    work = says.then(() => runWork(deps, filed, job, spec));
                }
                if (frame.kind === "stopped") {
                    stopped.abort();
                }
            }
        } catch (error) {
            deps.log(`job ${filed.id}: its stream from the sandbox broke: ${errorMessage(error)}`);
        } finally {
            // The stream ends once the job did, however it ended: whatever the work still does is read by nobody.
            stopped.abort();
            await work;
        }
    })();
    return { id: filed.id, ahead: filed.ahead };
};
