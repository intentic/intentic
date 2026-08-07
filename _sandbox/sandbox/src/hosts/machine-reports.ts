import {
    type Computer,
    type ComputerGap,
    type MachineFlowLine,
    type MachineReport,
    MachineReportSchema,
    type MachineSandbox,
    type MachineSandboxFlow,
    MachineSandboxSchema,
} from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Services } from "../composition.js";
import { enrolledMachines, machineReports } from "../platform/sync.js";
import { hostSummaries } from "./host.routes.js";

/* THE COMPUTERS VIEW'S DATA — every machine on the other end of this sandbox, however it is reachable.
 *
 * Two independent doors, and this is where they meet:
 *
 *   • The desktop-sync agent VOLUNTEERS its report on the ports poll it already makes. Costs the daemon nothing,
 *     needs no capability, and is how most users' machines appear here.
 *   • A `host` capability lets the daemon ASK. That is the only sanctioned channel from a sandbox to a machine —
 *     the docker socket is never mounted (see @intentic/sandbox-run's posture comment) and the docker capability
 *     grants a NESTED engine, so a sandbox can never see its siblings by itself. It adds the two things the
 *     volunteered report cannot carry: the machine's containers, and machines with no sync agent at all.
 *
 * The pulled half deliberately runs the SAME `intentic-sync status --json` the desktop app spawns, rather than a
 * second implementation of the same questions. One producer is what stops the terminal answer and the two
 * on-screen answers from drifting — the argument the desktop app already makes for spawning connect.sh. */

// How long a pulled report is served before the machine is asked again. Every open Computers tab polls this
// route, and the far end is somebody's laptop over a WebSocket — so the cost of the tab must not scale with how
// long it is left open. Comfortably shorter than the sync agent's own reporting cadence, so the pulled half is
// never the stale one.
const PULL_TTL_MS = 10_000;

// Reading a machine's own state is a fast local command. Anything slower is a machine in trouble, and the tab is
// better off saying so than holding the request open.
const PULL_TIMEOUT_MS = 15_000;

// The ceiling on one management flow. Far above what any of them should take — an update on a slow connection
// pulls a multi-gigabyte image — because the machine bounds its own work and this only ever catches a socket that
// died without closing. A flow cut off here has still happened; it is the WATCHING that ends, which is why the
// view re-reads the fleet afterwards rather than trusting what it last saw.
const FLOW_TIMEOUT_MS = 60 * 60 * 1000;

const pulled = new Map<string, { readonly at: number; readonly result: PullResult }>();

export type PullResult = { readonly report: MachineReport } | { readonly gap: ComputerGap };

/* `run_command` answers in PROSE — an exit line, then the streams under `--- stdout ---` fences (see the host
 * agent's describeResult). That is right for the agent, which is its only other caller, and it means a machine
 * reader has to find its JSON inside a human answer.
 *
 * Rather than parse the fences, take the last line that is a JSON object: the report is emitted by
 * `JSON.stringify` on one line, and no other line in that answer can be one. It survives the fence wording
 * changing, a shell that prepends a banner, and a stderr warning riding along. */
const safeJson = (line: string): unknown => {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
};

export const reportFrom = (text: string): MachineReport | undefined => {
    for (const line of text.split(/\r?\n/).toReversed()) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
            continue;
        }
        // Brace-shaped is not JSON-shaped: a shell that echoed `{...}` at us, or a progress line wearing braces,
        // must skip to the next candidate rather than take down the whole read with a parse throw.
        const parsed = safeJson(trimmed);
        if (parsed === undefined) {
            continue;
        }
        const report = MachineReportSchema.safeParse(parsed);
        if (report.success) {
            return report.data;
        }
    }
    return undefined;
};

// The text of an MCP tool result, plus whether the machine refused it. A refusal is a VALUE on this path (the
// host agent's own rule), so "Run commands is off" arrives here as ordinary content rather than as a throw.
const toolText = (answer: unknown): { text: string; refused: boolean } => {
    const result = (answer as { result?: { content?: { text?: unknown }[]; isError?: unknown } }).result;
    const text = (result?.content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
    return { text, refused: result?.isError === true };
};

const callTool = async (services: Services, id: string, name: string, args: Record<string, unknown>): Promise<{ text: string; refused: boolean }> =>
    toolText(
        await services.hostHub.mcp(id, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
        }),
    );

const MachineSandboxRowsSchema = z.array(MachineSandboxSchema);

/* The machine's containers, which the sync agent never reports (a sync agent enumerating a machine's other
 * sandboxes to one of them is the disclosure the whole design avoids by construction). Asking through a host
 * capability is different: the owner ticked a switch that says this sandbox may look there.
 *
 * Asked of the machine's own `list_sandboxes` tool, which owns the sidecar merging and answers the row JSON
 * directly — the machine is the one producer of "what runs on me", for this reader, for the agent and for its
 * own manage_sandbox. An agent too old to have the tool refuses it, which reads here exactly like a machine
 * that runs no sandboxes — and its age is already visible on the row (agents.host). */
export const sandboxesFromTool = (text: string, refused: boolean): MachineSandbox[] => {
    if (refused) {
        return [];
    }
    const rows = MachineSandboxRowsSchema.safeParse(safeJson(text.trim()));
    return rows.success ? rows.data : [];
};

// Ask one connected machine what it looks like. Every failure mode is a NAMED gap rather than an absence, because
// each is a different errand for whoever is reading the tab.
const pull = async (services: Services, id: string): Promise<PullResult> => {
    const { text, refused } = await callTool(services, id, "run_command", { command: "intentic-sync status --json", timeoutMs: PULL_TIMEOUT_MS });
    if (refused) {
        // The host agent refuses out-of-scope calls as a value naming the switch. Anything else refused here is
        // still, from the reader's side, "this machine would not answer" — and the tab's remedy is the same.
        return { gap: "scope-off" };
    }
    const report = reportFrom(text);
    if (report === undefined) {
        return { gap: "no-agent" };
    }
    // The containers are the reason to have asked at all; a machine that answers the report but not the fleet
    // still contributes everything else.
    const sandboxes = await callTool(services, id, "list_sandboxes", {})
        .then((answer) => sandboxesFromTool(answer.text, answer.refused))
        .catch((): MachineSandbox[] => []);
    return { report: { ...report, sandboxes, agents: { ...report.agents, host: services.hostHub.state(id).version } } };
};

const pullCached = async (services: Services, id: string): Promise<PullResult> => {
    const cached = pulled.get(id);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < PULL_TTL_MS) {
        return cached.result;
    }
    const result = await pull(services, id).catch((): PullResult => ({ gap: "offline" }));
    pulled.set(id, { at: now, result });
    return result;
};

/* THE RECONCILIATION, as a pure function of the three things that feed it — which machines are enrolled, what
 * they volunteered, and what each host capability answered. Pure because this is the part with a judgement in it,
 * and a judgement is worth testing without a WebSocket, a tmpdir and a capability store standing behind it.
 *
 * It is deliberately conservative: a sync enrollment and a host capability collapse into ONE row only when both
 * produced a report and those reports agree on the hostname. Anything weaker is a guess, and the guess that goes
 * wrong merges two collaborators' laptops into a single row on a shared sandbox. */
export const mergeComputers = (
    enrolled: readonly string[],
    volunteered: readonly { machine: string; report: MachineReport }[],
    hosts: readonly { id: string; online: boolean; result: PullResult }[],
): Computer[] => {
    // Driven by the ENROLLMENT list, not the report list: a machine that has never posted still gets a row, which
    // is the whole difference between "your laptop's agent is too old to report" and the sandbox quietly
    // pretending the laptop is not there.
    const rows: Computer[] = enrolled.map((machine) => {
        const report = volunteered.find((entry) => entry.machine === machine)?.report;
        return {
            key: report?.hostname ?? machine,
            label: machine,
            syncEnrolled: true,
            ...(report === undefined ? {} : { report }),
        };
    });

    for (const host of hosts) {
        const report = "report" in host.result ? host.result.report : undefined;
        const existing = report === undefined ? undefined : rows.find((row) => row.key === report.hostname);
        if (existing !== undefined) {
            // The same box through both doors. The pulled report wins because it alone carries the containers;
            // the sync-enrolled label stays because it is the name this sandbox has always shown for the machine.
            Object.assign(existing, { hostId: host.id, online: host.online, report });
            continue;
        }
        rows.push({
            key: report?.hostname ?? host.id,
            label: host.id,
            syncEnrolled: false,
            hostId: host.id,
            online: host.online,
            ...(report === undefined ? { gap: "gap" in host.result ? host.result.gap : "offline" } : { report }),
        });
    }

    // An enrolled machine with no report says so, rather than rendering as a computer that has no folders and no
    // ports — which is exactly what one running an agent too old to report would otherwise look like.
    for (const row of rows) {
        if (row.report === undefined && row.gap === undefined) {
            row.gap = "unreported";
        }
    }
    return rows;
};

// The IO half: read both doors, ask every host that is actually up, and hand the three lists to the merge above.
export const computers = async (services: Services): Promise<Computer[]> => {
    const hosts = await hostSummaries(services);
    const answered = await Promise.all(
        hosts.map(async (host) => ({
            id: host.id,
            online: host.online,
            // An offline machine is never asked: the call would hang until the hub's own timeout to produce an
            // answer that is already knowable.
            result: host.online ? await pullCached(services, host.id) : ({ gap: "offline" } as const),
        })),
    );
    return mergeComputers(await enrolledMachines(services.config.historyRoot), await machineReports(services.config.historyRoot), answered);
};

/* One management action on one machine's sandbox — the Computers view's buttons — relayed to the machine and
 * narrated back as it happens.
 *
 * Streamed rather than awaited because the slowest of these takes MINUTES: an update pulls an image and recreates
 * a container, and a button that spins in silence for that long is indistinguishable from one that is broken.
 * The lines are the machine's own, verbatim — this side adds no progress model of its own, exactly as the desktop
 * app promotes `ic`'s output rather than inventing steps beside it.
 *
 * The daemon adds no judgement either. The machine enforces its own switches ("Manage sandboxes" for six of
 * these, a separate one for removal) and a refusal arrives as the terminal `error` line in the machine's own
 * words, naming the control to flip. What this side does is drop the cached pull, so the very next poll shows the
 * fleet as the action left it rather than as the TTL remembers it. */
export async function* manageMachineSandbox(services: Services, id: string, input: MachineSandboxFlow): AsyncGenerator<MachineFlowLine> {
    const client = services.hostHub.client(id);
    if (client === undefined) {
        throw new ORPCError("CONFLICT", {
            message: `"${id}" is not connected right now — the computer is asleep, offline, or its agent isn't running.`,
        });
    }
    try {
        // The machine bounds its own work; this ceiling only ever catches a socket that is gone but not closed.
        yield* await client.runSandboxFlow(input, { signal: AbortSignal.timeout(FLOW_TIMEOUT_MS) });
    } finally {
        /* In `finally` rather than after the loop, because the interesting cases are the ones that do not reach
         * it: a removal that failed halfway still changed the machine, and a reader who navigated away mid-update
         * must not come back to a cache that predates it. */
        pulled.delete(id);
    }
}
