import {
    type Device,
    type DeviceAgentFlow,
    type DeviceGap,
    type HostSummary,
    type DeviceFlowLine,
    type DeviceReport,
    DeviceReportSchema,
    type DeviceSandbox,
    type DeviceSandboxFlow,
    DeviceSandboxSchema,
} from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Services } from "../composition.js";
import { approvedPath } from "../environment/environment.js";
import { enrolledFleet, type SyncEnrollmentRow } from "../platform/sync.js";
import { emitDefinitionToml, settingsDefinition } from "../portability/definition.js";
import { hostSummaries } from "./host-peer.js";

// Every machine reachable from this sandbox, via two doors: the desktop-sync agent's volunteered report (free, no
// capability needed) and a `host` capability's pull (adds containers and agent-less machines, never a mounted docker
// socket). The pull runs the same `intentic-machine status --json` the desktop app spawns, so the two answers cannot
// drift.

// How old a served reading may be before re-asking; readers never wait on this, refresh runs behind it.
const PULL_TTL_MS = 30_000;

// Deadline on one reading; the machine's own budget sits below it, so an overrun surfaces as its own answer.
const COMMAND_TIMEOUT_MS = 5_000;
const PULL_TIMEOUT_MS = 8_000;

// Ceiling on a management flow; the machine bounds its own work, a cutoff here only ends the watching.
const FLOW_TIMEOUT_MS = 60 * 60 * 1000;

// Ceiling for watching an update: above the download, below the flow ceiling; the view then polls the version.
const AGENT_FLOW_TIMEOUT_MS = 15 * 60 * 1000;

export type PullResult = { readonly report: DeviceReport } | { readonly gap: DeviceGap };

// One machine's last reading, plus any refresh currently in flight for it. `inflight` de-dupes concurrent readers into
// a single pull.
interface PullEntry {
    /** When `result` landed. Zero until the first reading of this daemon's life does. */
    at: number;
    /** The last complete reading, served while a newer one is being fetched. */
    result: PullResult | undefined;
    /** The refresh on the wire, so however many readers arrive, the machine is asked once. */
    inflight: Promise<PullResult> | undefined;
}

const pulled = new Map<string, PullEntry>();

// Drops the cached reading for a machine that just changed; deleted rather than aged out, so the next read blocks on a
// fresh answer.
export const forgetPull = (id: string): void => void pulled.delete(id);

// run_command answers in prose (exit line plus fenced streams); the report is the last line that parses as a JSON
// object, since only that line can be one.
const safeJson = (line: string): unknown => {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
};

export const reportFrom = (text: string): DeviceReport | undefined => {
    for (const line of text.split(/\r?\n/).toReversed()) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
            continue;
        }
        // Brace-shaped is not JSON-shaped; a non-parsing candidate is skipped, not thrown on.
        const parsed = safeJson(trimmed);
        if (parsed === undefined) {
            continue;
        }
        // The report is the `sync` half of the agent's status envelope; the rest is already known to the daemon.
        const report = DeviceReportSchema.safeParse((parsed as { sync?: unknown }).sync);
        if (report.success) {
            return report.data;
        }
    }
    return undefined;
};

// Text of an MCP tool result, plus whether the machine refused it; a refusal is a value on this path, not a throw.
const toolText = (answer: unknown): { text: string; refused: boolean } => {
    const result = (answer as { result?: { content?: { text?: unknown }[]; isError?: unknown } }).result;
    const text = (result?.content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
    return { text, refused: result?.isError === true };
};

// Exported so every caller of the hub's MCP door reads an answer the same way.
export const callTool = async (
    services: Services,
    id: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
): Promise<{ text: string; refused: boolean }> =>
    toolText(
        await services.hostHub.mcp(
            id,
            {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name, arguments: args },
            },
            { signal },
        ),
    );

const DeviceSandboxRowsSchema = z.array(DeviceSandboxSchema);

// Containers come only through an approved host capability, never the sync agent. Reads the machine's own
// list_sandboxes tool; a refusal or too-old agent reads as no sandboxes.
export const sandboxesFromTool = (text: string, refused: boolean): DeviceSandbox[] => {
    if (refused) {
        return [];
    }
    const rows = DeviceSandboxRowsSchema.safeParse(safeJson(text.trim()));
    return rows.success ? rows.data : [];
};

// Every failure reads as a named gap, not an absence. Status and fleet go out together under one deadline; the status
// call alone decides no-agent/scope-off.
const pull = async (services: Services, id: string): Promise<PullResult> => {
    // One deadline over both calls: the reading is what has a budget, not either half of it.
    const signal = AbortSignal.timeout(PULL_TIMEOUT_MS);
    const [status, fleet] = await Promise.all([
        callTool(services, id, "run_command", { command: "intentic-machine status --json", timeoutMs: COMMAND_TIMEOUT_MS }, signal),
        callTool(services, id, "list_sandboxes", {}, signal).catch(() => ({ text: "", refused: true })),
    ]);
    if (status.refused) {
        // A scope refusal is a named value; any other refusal here still reads as "this machine would not answer".
        return { gap: "scope-off" };
    }
    const report = reportFrom(status.text);
    if (report === undefined) {
        return { gap: "no-agent" };
    }
    const sandboxes = sandboxesFromTool(fleet.text, fleet.refused);
    // Report's agent block is left as stated; version rides the row (agentVersion) instead, not merged here.
    return { report: { ...report, sandboxes } };
};

// One refresh per machine, stamped when it lands, not when it started, so a slow pull's duration is already spent
// against the reading's age.
const refresh = (services: Services, id: string, entry: PullEntry): Promise<PullResult> => {
    const inflight = services.perf
        .track("devices.pull", { id }, () => pull(services, id))
        // Never rejects (an abandoned caller leaves nothing unhandled); a deadline miss reads as offline.
        .catch((): PullResult => ({ gap: "offline" }))
        .then((result) => {
            entry.at = Date.now();
            entry.result = result;
            if (entry.inflight === inflight) {
                entry.inflight = undefined;
            }
            return result;
        });
    entry.inflight = inflight;
    return inflight;
};

// Answers from memory while a refresh runs behind it; only a machine never read before blocks, bounded by
// PULL_TIMEOUT_MS.
const pullCached = async (services: Services, id: string): Promise<PullResult> => {
    const entry = pulled.get(id) ?? { at: 0, result: undefined, inflight: undefined };
    pulled.set(id, entry);
    if (entry.result !== undefined && Date.now() - entry.at < PULL_TTL_MS) {
        return entry.result;
    }
    const inflight = entry.inflight ?? refresh(services, id, entry);
    // Stale but serving: the refresh is not awaited here, it lands in the map for the next reader to pick up.
    return entry.result ?? (await inflight);
};

// Maps os.platform()'s spelling (win32, darwin) to capability-card slugs; unknown tokens pass through as-is.
const PLATFORM_SLUGS: Record<string, string> = { win32: "windows", darwin: "macos", linux: "linux" };

// The capability card's platform wins when set; it's known even before the machine ever answers.
const platformOf = (declared: string | undefined, report: DeviceReport | undefined): string | undefined =>
    declared ?? (report === undefined ? undefined : (PLATFORM_SLUGS[report.os] ?? report.os));

// Pure reconciliation of enrollments, volunteered reports and host pulls into rows, testable without IO. Conservative:
// a sync enrollment and host capability fold into one row only when both report and their hostnames agree.
export const mergeDevices = (
    // Full enrollments, not names: a row must say which half of sync a machine holds and address it to revoke.
    enrolled: readonly SyncEnrollmentRow[],
    volunteered: readonly { machine: string; report: DeviceReport }[],
    // Full host summary, not just id/liveness: connect-time facts are the only description a report-less row has.
    hosts: readonly { host: HostSummary; result: PullResult }[],
): Device[] => {
    // Driven by the enrollment list, not the report list, so a machine that never posted still gets a row.
    const rows: Device[] = enrolled.map((enrollment) => {
        const report = volunteered.find((entry) => entry.machine === enrollment.machine)?.report;
        const platform = platformOf(undefined, report);
        return {
            key: report?.hostname ?? enrollment.machine,
            label: enrollment.machine,
            sync: enrollment,
            ...(platform === undefined ? {} : { platform }),
            ...(report === undefined ? {} : { report }),
        };
    });

    // Claims a row by hostname if the host answered, else by capability id matching the enrollment's name. Answered
    // hosts claim first, so a name match never outranks a real answer, and no rule may steal an occupied row.
    const claim = (report: DeviceReport | undefined, id: string): Device | undefined =>
        report === undefined
            ? rows.find((row) => row.hostId === undefined && row.label.toLowerCase() === id.toLowerCase())
            : rows.find((row) => row.hostId === undefined && row.key === report.hostname);

    // Row keys must be unique, a shared key is a rendering fault; the capability id always works as a fallback.
    const taken = new Set(rows.map((row) => row.key));
    const distinct = (preferred: string, id: string): string =>
        [preferred, id, `${preferred}:${id}`].find((candidate) => !taken.has(candidate)) ?? `${preferred}:${id}:${rows.length}`;

    const answered = hosts.filter((entry) => "report" in entry.result);
    const silent = hosts.filter((entry) => !("report" in entry.result));
    for (const { host, result } of [...answered, ...silent]) {
        const report = "report" in result ? result.report : undefined;
        // Everything this side knows about the machine itself, as opposed to what it is doing for this sandbox.
        const platform = platformOf(host.platform, report);
        const identity = {
            hostId: host.id,
            online: host.online,
            ...(platform === undefined ? {} : { platform }),
            ...(host.facts === undefined ? {} : { facts: host.facts }),
            ...(host.version === undefined ? {} : { agentVersion: host.version }),
            ...(host.lastSeen === undefined ? {} : { lastSeen: host.lastSeen }),
        };
        const existing = claim(report, host.id);
        if (existing !== undefined) {
            // Pulled report wins; a shut door removes nothing, only sets online:false. gap only when nothing else
            // shows.
            Object.assign(existing, {
                ...identity,
                ...(report === undefined ? {} : { report }),
                ...(report === undefined && existing.report === undefined ? { gap: "gap" in result ? result.gap : "offline" } : {}),
            });
            continue;
        }
        const key = distinct(report?.hostname ?? host.id, host.id);
        taken.add(key);
        rows.push({
            key,
            label: host.id,
            ...identity,
            ...(report === undefined ? { gap: "gap" in result ? result.gap : "offline" } : { report }),
        });
    }

    // No report reads as "unreported", not as empty folders/ports, which a too-old agent would also look like.
    for (const row of rows) {
        if (row.report === undefined && row.gap === undefined) {
            row.gap = "unreported";
        }
    }
    return rows;
};

// IO half: reads both doors and every up host, feeding mergeDevices. Timed as its own perf span (devices.read vs
// devices.pull) so a slow tab is attributable to the daemon or to a machine.
export const devices = async (services: Services): Promise<Device[]> =>
    services.perf.track("devices.read", {}, async () => {
        const hosts = await hostSummaries(services);
        const answered = await Promise.all(
            hosts.map(async (host) => ({
                host,
                // An offline machine is never asked; the call would just hang until the deadline for an answer already
                // known.
                result: host.online ? await pullCached(services, host.id) : ({ gap: "offline" } as const),
            })),
        );
        const fleet = await enrolledFleet(services.config.historyRoot);
        return mergeDevices(fleet.machines, fleet.reports, answered);
    });

// One management action relayed to the machine and streamed back verbatim (some flows take minutes); the daemon adds no
// judgement of its own, only drops the cached pull so the next poll reflects the result.
export async function* manageDeviceSandbox(services: Services, id: string, input: DeviceSandboxFlow): AsyncGenerator<DeviceFlowLine> {
    const client = services.hostHub.client(id);
    if (client === undefined) {
        throw new ORPCError("CONFLICT", {
            message: `"${id}" is not connected right now, the device is asleep, offline, or its agent isn't running.`,
        });
    }
    // runner-up is the only augmented op: adds a dial URL and a name-bound pairing; refused without a public URL.
    const flow: DeviceSandboxFlow =
        input.op === "runner-up"
            ? await (async () => {
                  const parentUrl = services.config.sandbox.publicUrl;
                  if (parentUrl === "") {
                      throw new ORPCError("CONFLICT", {
                          message: "This sandbox has no public address yet, so a runner would have nothing to dial back to. Finish its setup first.",
                      });
                  }
                  // Overlay ships as approved bytes plus sha256, re-checked on the machine; definition ships settings
                  // only, best-effort.
                  const definition = await Promise.resolve()
                      .then(() => settingsDefinition(services))
                      .then((settings) => (Object.keys(settings.settings).length === 0 ? undefined : emitDefinitionToml(settings)))
                      .catch(() => undefined);
                  const overlay = await Promise.resolve()
                      .then(() => services.files.read(approvedPath(services)))
                      .catch(() => undefined);
                  return {
                      ...input,
                      parentUrl,
                      pair: services.runners.mintPairing(input.slug, { host: id }).token,
                      ...(definition !== undefined ? { definition } : {}),
                      ...(overlay !== undefined && overlay !== "" ? { overlay, overlayHash: sha256Hex(overlay) } : {}),
                  };
              })()
            : input;
    try {
        // The machine bounds its own work; this ceiling only ever catches a socket that is gone but not closed.
        for await (const line of await client.runSandboxFlow(flow, { signal: AbortSignal.timeout(FLOW_TIMEOUT_MS) })) {
            // Forgets a removed runner only on success; a failed removal leaves the container running still.
            if (line.kind === "result" && input.op === "runner-remove") {
                services.runnerHub.disconnect(input.slug, "this runner was removed from its machine");
                await services.runners.revoke(input.slug);
            }
            yield line;
        }
    } finally {
        // In `finally`: a failed or abandoned run still changed the machine; deletion forces a fresh next read.
        pulled.delete(id);
    }
}

// Updates or restarts the device's agent, the one flow that expects its own transport to die with the process it stops.
// Confirmation is the version changing on the next read, not a terminal frame.
export async function* runDeviceAgentFlow(services: Services, id: string, input: DeviceAgentFlow): AsyncGenerator<DeviceFlowLine> {
    const client = services.hostHub.client(id);
    if (client === undefined) {
        throw new ORPCError("CONFLICT", {
            message: `"${id}" is not connected right now, the device is asleep, offline, or its agent isn't running.`,
        });
    }
    try {
        for await (const line of await client.runAgentFlow(input, { signal: AbortSignal.timeout(AGENT_FLOW_TIMEOUT_MS) })) {
            yield line;
        }
    } catch (error) {
        // Dying mid-flow reads as success here, not failure; a refusal the device answered with still passes through.
        const message = error instanceof Error ? error.message : String(error);
        yield { kind: "line", text: `Lost contact with ${id} while that ran, which is what restarting its agent does to this connection.` };
        yield {
            kind: "result",
            message: `${message} — if the version below does not change in a few minutes, run \`intentic-machine upgrade\` on that device.`,
        };
    } finally {
        // Clears the cache: the agent may be a different build now, and the version change is this flow's answer.
        pulled.delete(id);
    }
}
