import { within } from "@intentic/base/async";
import {
    type Device,
    type DeviceAgentFlow,
    type DeviceGap,
    type DevicePairing,
    type DeviceFlowLine,
    type DeviceReport,
    type DeviceSandbox,
    type DeviceSandboxFlow,
    environmentOf,
    REPORT_QUIET_AFTER_MS,
} from "@intentic/sandbox-contract/schemas/devices";
import {
    type HostSummary,
    HOST_NATIVE_ENVIRONMENT,
} from "@intentic/sandbox-contract/schemas/hosts";
import { sandboxSlugOf } from "@intentic/sandbox-run";
import { ORPCError } from "@orpc/server";
import { refuseUnsupported } from "./device-feature-gates.js";
import { commandingCards, withHostShell } from "./egress/host-shell.js";
import { withEgressOwnerKeys } from "./egress/owner-keys.js";
import type { Services } from "../composition.js";
import { composeEnvironment } from "../environment/overlay.js";
import { opt } from "../opt.js";
import type { SyncEnrollmentRow } from "../peers/desktop-sync.js";
import { emitDefinitionToml, settingsDefinition } from "../definition/definition.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { type HostClient, type HostFiles, hostConnections, hostSummaries, readHostFiles } from "./host-peer.js";
import { hostIdFrom, setupHostCard } from "./host-seed.js";
import { factsDue, refreshFactsBeside, refreshFactsOnceSettled } from "./device-facts-refresh.js";
import { sandboxesFromTool, unreadFromTool,type AnswerMemory,gapOf,keepLastAnswer,type LateHalves,lateReason,noteReading,type Reading } from "./device-listing.js";

// Every machine reachable from this sandbox, via two doors: the desktop-sync agent's volunteered report (free, no
// capability needed) and a `host` capability's pull (adds containers, never a mounted docker socket). The pull asks the
// agent on its own connection (`report`), which answers with the same `deviceReport` its `status --json` prints for the
// desktop app, so the two answers cannot drift.

// How old a served reading may be before re-asking; readers never wait on this, refresh runs behind it.
const PULL_TTL_MS = 30_000;

// How long readers wait for a refresh once the held reading is old enough to read as quiet. Below that age the old
// copy is served at once; past it, handing it over would only be contradicted a second later, which is what makes a
// healthy machine look dead the moment its page opens. One window per refresh, counted from when it went out, and only
// for a machine whose last reading came back inside it: a laptop that takes 4-8 s to list its containers never landed
// in time, so every reader paid the whole 2 s for the quiet copy it was then handed anyway (GET /system/devices sat at
// a flat 2.0 s p50, 2026-10-21). The landing announces itself (`worthAnnouncing`), so the view still catches up.
const PULL_SETTLE_MS = 2_000;

// Deadline on one reading, both halves together. A half that misses it keeps what the machine last said (device-listing.ts).
const PULL_TIMEOUT_MS = 8_000;

// Ceiling on a management flow; the machine bounds its own work, a cutoff here only ends the watching.
const FLOW_TIMEOUT_MS = 60 * 60 * 1000;

// Ceiling for watching an update: above the download, below the flow ceiling; the view then polls the version.
const AGENT_FLOW_TIMEOUT_MS = 15 * 60 * 1000;

// One reading, in two halves that arrive independently because they ride two different switches: the machine's
// description of itself (`report`, behind "Run commands") and the containers it holds (`list_sandboxes`, behind
// "Manage sandboxes on this device"). No report still means a named gap; `sandboxes` is absent only when nobody could
// look, so an empty list stays the answer "none there".
export type PullResult = ({ readonly report: DeviceReport } | { readonly gap: DeviceGap }) & {
    readonly sandboxes?: readonly DeviceSandbox[];
    // The machine's own sentence for not listing, when it answered with one (Device.sandboxesUnread).
    readonly sandboxesUnread?: string;
};

// One machine's last reading, plus any refresh currently in flight for it. `inflight` de-dupes concurrent readers into
// a single pull.
interface PullEntry {
    /** When `result` landed. Zero until the first reading of this daemon's life does. */
    at: number;
    /** The last complete reading, served while a newer one is being fetched. */
    result: PullResult | undefined;
    /** The refresh on the wire, so however many readers arrive, the machine is asked once. */
    inflight: Promise<PullResult> | undefined;
    /** When the refresh on the wire went out: the settle window is that refresh's, not each reader's. */
    sentAt: number;
    /** How long the last reading took to land, which says whether waiting on the next one can pay. */
    took: number;
    /** Each half's last real answer, what a late half is read as. */
    answered: AnswerMemory;
    /** Moved by `stalePull`: a refresh sent under an older count read the machine before it changed, and lands nowhere. */
    epoch: number;
}

const pulled = new Map<string, PullEntry>();

const entryOf = (id: string): PullEntry => {
    const entry = pulled.get(id) ?? { at: 0, result: undefined, inflight: undefined, sentAt: 0, took: 0, answered: {}, epoch: 0 };
    pulled.set(id, entry);
    return entry;
};

// A machine that just changed: its held reading is aged past every window, so the next read asks again and waits for
// the answer only as long as a quiet copy would (PULL_SETTLE_MS), and the refresh's landing is announced. A refresh
// already on the wire may have read the machine before the change, so it lands nowhere, and a half that comes back late
// is no longer read as what the machine said before it. Kept rather than deleted (2026-11-06): a deleted reading made
// the next reader wait out the whole pull, 6-8 s on a loaded host, and the Rebuild card's log poll deleted it every 4 s.
export const stalePull = (id: string): void => {
    const entry = pulled.get(id);
    if (entry === undefined) {
        return;
    }
    entry.at = 0;
    entry.inflight = undefined;
    entry.answered = {};
    entry.epoch += 1;
    factsDue(id);
};

// Text of an MCP tool result, plus whether the machine refused it; a refusal is a value on this path, not a throw.
const toolText = (answer: unknown): { text: string; refused: boolean } => {
    const result = (answer as { result?: { content?: { text?: unknown }[]; isError?: unknown } }).result;
    const text = (result?.content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
    return { text, refused: result?.isError === true };
};

// Exported so every caller of the hub's MCP door reads an answer the same way.
export const callTool = async (
    services: Pick<Services, "hostHub">,
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

// FORBIDDEN is the "Run commands" switch, any other refusal an agent without the call; a transport failure throws.
const describeMachine = async (client: HostClient, signal: AbortSignal): Promise<{ readonly report: DeviceReport } | { readonly gap: DeviceGap }> => {
    try {
        return { report: await client.report(undefined, { signal }) };
    } catch (error) {
        if (!(error instanceof ORPCError)) {
            throw error;
        }
        return { gap: error.code === "FORBIDDEN" ? "scope-off" : "unreported" };
    }
};

// Every failure reads as a named gap, not an absence. Report and fleet go out together under one deadline and settle
// apart: the report alone decides the gap, and the fleet answer survives either verdict, a late report included — a
// card granting sandbox management and nothing else lists its containers while refusing to describe the machine, and
// that list is what every "do it out there" button is gated on.
const pull = async (services: Services, id: string): Promise<Reading> => {
    const client = services.hostHub.client(id);
    if (client === undefined) {
        return { result: { gap: "offline" }, late: {} };
    }
    // One deadline over both calls: the reading is what has a budget, not either half of it.
    const signal = AbortSignal.timeout(PULL_TIMEOUT_MS);
    const late: LateHalves = {};
    refreshFactsBeside(services, id);
    const [described, fleet] = await Promise.all([
        describeMachine(client, signal).catch((error: Error) => {
            late.report = lateReason(error, PULL_TIMEOUT_MS);
            return { gap: "offline" } as const;
        }),
        callTool(services, id, "list_sandboxes", {}, signal).catch((error: Error) => {
            late.sandboxes = lateReason(error, PULL_TIMEOUT_MS);
            return { text: "", refused: true };
        }),
    ]);
    // Absent, not empty, when the machine wouldn't answer: "none there" is a reading, and this isn't one.
    // Report's agent block is left as stated; version rides the row (agentVersion) instead, not merged here.
    const sandboxes = sandboxesFromTool(fleet.text, fleet.refused);
    const unread = sandboxes === undefined && late.sandboxes === undefined ? unreadFromTool(fleet.text, fleet.refused) : undefined;
    return {
        result: { ...described, ...(sandboxes === undefined ? {} : { sandboxes }), ...(unread === undefined ? {} : { sandboxesUnread: unread }) },
        late,
    };
};

// Which containers the machine holds and whether each runs, as one comparable string; undefined when it did not list.
const containersOf = (result: PullResult): string | undefined =>
    result.sandboxes
        ?.map((box) => `${box.slug}:${box.running ? "up" : "down"}`)
        .toSorted()
        .join(",");

// A landing worth waking watchers for: the machine's first reading, a change in whether it answers at all or in the
// containers it holds, or a fresh reading replacing one already old enough to read as quiet. Containers count because
// a reader that does not poll (the switcher's remove dialog, a row's placement) decides "is there a button for this" on
// them, and a sandbox created or removed out there would otherwise stay unknown to it until the page reloads. A
// routine refresh of a healthy device announces nothing, so an open Devices tab is not refetched every TTL for news it
// already has.
const worthAnnouncing = (before: { at: number; result: PullResult | undefined }, after: PullResult, at: number): boolean =>
    before.result === undefined ||
    gapOf(before.result) !== gapOf(after) ||
    containersOf(before.result) !== containersOf(after) ||
    at - before.at > REPORT_QUIET_AFTER_MS;

// One refresh per machine, stamped when it lands, not when it started, so a slow pull's duration is already spent
// against the reading's age.
const refresh = (services: Services, id: string, entry: PullEntry): Promise<PullResult> => {
    const had = { at: entry.at, result: entry.result };
    const sentAt = Date.now();
    const epoch = entry.epoch;
    const inflight = services.perf
        .track("devices.pull", { id }, () => pull(services, id))
        // Never rejects (an abandoned caller leaves nothing unhandled); a pull that threw whole got no answer at all.
        .catch((error: Error): Reading => {
            const reason = lateReason(error, PULL_TIMEOUT_MS);
            return { result: { gap: "offline" }, late: { report: reason, sandboxes: reason } };
        })
        .then((reading) => {
            // Read before the machine changed under it (stalePull): its reader is answered, the memory is not touched.
            if (entry.epoch !== epoch) {
                return reading.result;
            }
            entry.at = Date.now();
            const result = keepLastAnswer(entry.answered, reading, entry.at);
            entry.result = result;
            entry.took = entry.at - sentAt;
            noteReading(services, id, result, reading.late.report ?? reading.late.sandboxes);
            if (entry.inflight === inflight) {
                entry.inflight = undefined;
            }
            // Pushed on the /events stream as `devices`, which re-reads the Devices read and nothing else: a machine that
            // answers after the reader was served the copy it held is on screen in a second, not at the browser's next poll.
            if (worthAnnouncing(had, result, entry.at)) {
                publishRuntimeChange("devices");
            }
            return result;
        });
    entry.inflight = inflight;
    entry.sentAt = sentAt;
    return inflight;
};

// Answers from memory while a refresh runs behind it. Two readings block: a machine never read before (bounded by
// PULL_TIMEOUT_MS, and asked for as it connects, so a reader rarely meets one: `warmPull`) and one held long enough to
// read as quiet (what is left of the refresh's PULL_SETTLE_MS, and only when the machine's last reading landed inside
// it; then served anyway). The first has nothing else to serve: a row carries no "being read" mark, and the gap it would
// read as instead ("unreported") tells the owner to update the agent and takes every container button away.
const pullCached = async (services: Services, id: string): Promise<PullResult> => {
    const entry = entryOf(id);
    const held = entry.result;
    if (held !== undefined && Date.now() - entry.at < PULL_TTL_MS) {
        return held;
    }
    const inflight = entry.inflight ?? refresh(services, id, entry);
    if (held === undefined) {
        return await inflight;
    }
    if (Date.now() - entry.at <= REPORT_QUIET_AFTER_MS) {
        // Stale but serving: the refresh is not awaited here, it lands in the map for the next reader to pick up.
        return held;
    }
    const settle = entry.took > PULL_SETTLE_MS ? 0 : PULL_SETTLE_MS - (Date.now() - entry.sentAt);
    if (settle <= 0) {
        return held;
    }
    return (await within(inflight, settle, undefined, { unref: true })) ?? held;
};

// A machine's first reading, asked for as it connects rather than by the first reader, who would otherwise wait out the
// whole pull with nothing held to serve meanwhile. A machine already read is left to its readers.
export const warmPull = (services: Services, id: string): void => {
    const entry = entryOf(id);
    if (entry.result === undefined && entry.inflight === undefined) {
        void refresh(services, id, entry);
    }
};

// Maps os.platform()'s spelling (win32, darwin) to capability-card slugs; unknown tokens pass through as-is.
const PLATFORM_SLUGS: Record<string, string> = { win32: "windows", darwin: "macos", linux: "linux" };

// The capability card's platform wins when set; it's known even before the machine ever answers.
const platformOf = (declared: string | undefined, report: DeviceReport | undefined): string | undefined =>
    declared ?? (report === undefined ? undefined : (PLATFORM_SLUGS[report.os] ?? report.os));

// One host pull as the pieces a row is assembled from: the machine's own description, where it lands, everything this
// side knows about the machine regardless of whether it described itself, and the gap standing in for a missing
// description. Containers sit in `known` rather than the report because they answer to their own switch.
const pulledHost = (
    host: HostSummary,
    result: PullResult,
): {
    readonly report: DeviceReport | undefined;
    readonly platform: string | undefined;
    readonly known: Partial<Device>;
    readonly gap: DeviceGap;
} => {
    const report = "report" in result ? result.report : undefined;
    const platform = platformOf(host.platform, report);
    return {
        report,
        platform,
        known: {
            hostId: host.id,
            // A per-connection row names its card; a per-card summary's id is the card.
            card: host.card ?? host.id,
            online: host.online,
            ...(machineOfHost(host) === undefined ? {} : { machineId: machineOfHost(host) }),
            ...(platform === undefined ? {} : { platform }),
            ...(host.facts === undefined ? {} : { facts: host.facts }),
            ...(host.version === undefined ? {} : { agentVersion: host.version }),
            ...(host.lastSeen === undefined ? {} : { lastSeen: host.lastSeen }),
            ...opt("manages", host.manages),
            ...(result.sandboxes === undefined ? {} : { sandboxes: [...result.sandboxes] }),
            ...(result.sandboxesUnread === undefined ? {} : { sandboxesUnread: result.sandboxesUnread }),
        },
        // A result with neither half is not representable; "offline" keeps the fallback a named gap rather than none.
        gap: "gap" in result ? result.gap : "offline",
    };
};

// The computer a host connection is on: what its agent said at connect, else what its enrollment recorded when it last
// did (a side asleep since this daemon booted has no facts, and still has a machine).
const machineOfHost = (host: HostSummary): string | undefined => host.facts?.machineId ?? host.environments[0]?.machineId;

// The one join between the two doors: the same computer, and the same OS install on it. Both halves must have said:
// an agent too old to carry a machine id leaves its rows apart, which is honest, where the hostname this replaced
// joined a PC to a distro inside it, or two machines that shared a name.
const sameEnvironment = (
    left: { readonly machineId: string | undefined; readonly environment: string | undefined },
    right: { readonly machineId: string | undefined; readonly environment: string | undefined },
): boolean => left.machineId !== undefined && left.machineId === right.machineId && left.environment !== undefined && left.environment === right.environment;

// The environment a connection was enrolled as; the native one when nothing names another.
const connectionEnvironment = (host: HostSummary): string => host.environments[0]?.key ?? HOST_NATIVE_ENVIRONMENT;

// Pure reconciliation of enrollments, volunteered reports and host pulls into rows, testable without IO. A sync
// enrollment and a host connection fold into one row when both name the same machine and environment. The one other
// fold is setup's own card (`setupCard` below).
export const mergeDevices = (
    // Full enrollments, not names: a row must say which half of sync a machine holds and address it to revoke.
    enrolled: readonly SyncEnrollmentRow[],
    volunteered: readonly { machine: string; report: DeviceReport }[],
    // Full host summary, not just id/liveness: connect-time facts are the only description a report-less row has.
    hosts: readonly { host: HostSummary; result: PullResult }[],
    // The card setup made for the machine that ran it (host-seed.ts's setupHostCard), when it made one.
    setupCard?: string,
): Device[] => {
    // Driven by the enrollment list, not the report list, so a machine that never posted still gets a row.
    const rows: Device[] = enrolled.map((enrollment) => {
        const report = volunteered.find((entry) => entry.machine === enrollment.machine)?.report;
        const platform = platformOf(undefined, report);
        return {
            key: report?.hostname ?? enrollment.machine,
            label: enrollment.machine,
            sync: enrollment,
            ...(enrollment.machineId === undefined ? {} : { machineId: enrollment.machineId }),
            ...(platform === undefined ? {} : { platform }),
            ...(report === undefined ? {} : { report }),
        };
    });

    // A sync row's own say about which computer and install it is: its enrollment's record, else the report it posted.
    const syncIdentity = (row: Device) => ({
        machineId: row.sync?.machineId ?? row.report?.machineId,
        environment: row.sync?.environment ?? environmentOf(undefined, row.report),
    });
    // Which sync row each host connection folds into, settled before any row is built. No rule may steal an occupied
    // row, and every connection that said which machine it is claims before setup's card is placed by its name.
    const claims = new Map<number, Device>();
    const free = (row: Device): boolean => ![...claims.values()].includes(row);
    const claim = (host: HostSummary): Device | undefined => {
        // The environment the enrollment names (the connection's own), which no report can contradict.
        const identity = { machineId: machineOfHost(host), environment: connectionEnvironment(host) };
        return rows.find((row) => free(row) && sameEnvironment(syncIdentity(row), identity));
    };
    // SETUP'S CARD, PLACED BY THE NAME SETUP GAVE IT. The installer syncs the machine it runs on and connects it as a
    // device, the card named after that machine (hostIdFrom). When the device half never says which machine it is (the
    // connect step failed, or its agent predates machine ids and the PC later lost the link), the PC read as two devices:
    // one syncing, one offline for good. Only this card, only its native connection while it has said nothing, and only
    // into the one native sync row enrolled under that name: a WSL distro shares the PC's hostname, so the environment
    // must agree, and two rows of that name fold neither.
    const claimSetupMachine = (host: HostSummary): Device | undefined => {
        if (
            setupCard === undefined ||
            (host.card ?? host.id) !== setupCard ||
            machineOfHost(host) !== undefined ||
            connectionEnvironment(host) !== HOST_NATIVE_ENVIRONMENT
        ) {
            return undefined;
        }
        const named = rows.filter(
            (row) =>
                free(row) &&
                row.sync !== undefined &&
                syncIdentity(row).environment === HOST_NATIVE_ENVIRONMENT &&
                hostIdFrom(row.sync.machine) === setupCard,
        );
        return named.length === 1 ? named[0] : undefined;
    };
    for (const [index, { host }] of hosts.entries()) {
        const row = claim(host);
        if (row !== undefined) {
            claims.set(index, row);
        }
    }
    for (const [index, { host }] of hosts.entries()) {
        const row = claims.has(index) ? undefined : claimSetupMachine(host);
        if (row !== undefined) {
            claims.set(index, row);
        }
    }

    // Row keys must be unique, a shared key is a rendering fault; the capability id always works as a fallback.
    const taken = new Set(rows.map((row) => row.key));
    const distinct = (preferred: string, id: string): string =>
        [preferred, id, `${preferred}:${id}`].find((candidate) => !taken.has(candidate)) ?? `${preferred}:${id}:${rows.length}`;

    for (const [index, { host, result }] of hosts.entries()) {
        const { report, known, gap } = pulledHost(host, result);
        const existing = claims.get(index);
        if (existing !== undefined) {
            // Pulled report wins; a shut door removes nothing, only sets online:false. gap only when nothing else
            // shows.
            Object.assign(existing, {
                ...known,
                ...(report === undefined ? {} : { report }),
                ...(report === undefined && existing.report === undefined ? { gap } : {}),
            });
            continue;
        }
        const key = distinct(report?.hostname ?? host.id, host.id);
        taken.add(key);
        rows.push({ key, label: host.id, ...known, ...(report === undefined ? { gap } : { report }) });
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
// devices.pull) so a slow tab is attributable to the daemon or to a machine. `given` is the cards and enrollments a
// caller already read for the same request.
export const devices = async (services: Services, given?: HostFiles): Promise<Device[]> =>
    services.perf.track("devices.read", {}, async () => {
        const files = given ?? (await readHostFiles(services));
        // Per environment, not per card: Windows and each distro on it run their own agent, so each is read through its
        // own connection and lands as its own row with its own door.
        const hosts = hostConnections(await hostSummaries(services, files));
        const answered = await Promise.all(
            hosts.map(async (host) => ({
                host,
                // An offline machine is never asked; the call would just hang until the deadline for an answer already
                // known.
                result: host.online ? await pullCached(services, host.id) : ({ gap: "offline" } as const),
            })),
        );
        const fleet = await services.syncFleet();
        // Whether this sandbox runs commands on its own machine, which only this daemon knows (egress/host-shell.ts).
        const merged = mergeDevices(fleet.machines, fleet.reports, answered, setupHostCard(services.config));
        return withHostShell(merged, sandboxSlugOf(services.config.sandbox.name), commandingCards(files.cards));
    });

// The host-capability devices as the readings ALREADY IN HAND describe them: `devices` without the asking, for callers
// that must not spend a round trip on a laptop (composing a turn's prompt, deciding whether a route can act at all).
// Sync enrollments are absent on purpose rather than for cheapness: a volunteered report carries no `hostId`, so it
// could never be the machine a command is sent to. A host never read yet reads as a gap, never as an empty machine.
export const heldHostDevices = async (services: Services): Promise<Device[]> =>
    mergeDevices(
        [],
        [],
        hostConnections(await hostSummaries(services)).map((host) => ({
            host,
            result: pulled.get(host.id)?.result ?? ({ gap: host.online ? "unreported" : "offline" } as const),
        })),
    );

// The folders one machine pairs, as its freshest reading says: a connected machine is read as every reader reads it
// (served from memory within the TTL), one that dropped answers with what it last said before it went. Undefined when
// it never described itself to this daemon (its "Run commands" switch is off, or it was never read): what project
// delivery (conversations/land/project-delivery.ts) reads to find the computer holding an attached folder.
export const reportedPairings = async (services: Services, id: string): Promise<readonly DevicePairing[] | undefined> => {
    const result = services.hostHub.online(id) ? await pullCached(services, id) : pulled.get(id)?.result;
    return result !== undefined && "report" in result ? result.report.pairings : undefined;
};

// A setup code is redeemable only on the platform that minted it, which is this sandbox's own.
const mintingPlatform = (services: Services): string => {
    const url = services.config.platform.url;
    if (url === "") {
        throw new ORPCError("CONFLICT", {
            message: "This sandbox is not connected to a platform, so no setup code it relays could be redeemed anywhere.",
        });
    }
    return url;
};

// One management action relayed to the machine and streamed back verbatim (some flows take minutes); the daemon adds no
// judgement of its own, only drops the cached pull so the next poll reflects the result. `origin` is the browser's,
// which names the passkeys a `set-egress` carries.
type FlowOrigin = { readonly origin?: string | undefined };
export async function* manageDeviceSandbox(services: Services, id: string, input: DeviceSandboxFlow, { origin }: FlowOrigin = {}): AsyncGenerator<DeviceFlowLine> {
    const client = services.hostHub.client(id);
    if (client === undefined) {
        throw new ORPCError("CONFLICT", { message: services.hostHub.offline(id) });
    }
    refuseUnsupported(id, services.hostHub.state(id).facts, input);
    if (input.op === "set-shape" && (input.shape === undefined || input.when === undefined)) {
        throw new ORPCError("BAD_REQUEST", { message: "A shape is set whole, with when it takes effect: `shape` and `when` are both required." });
    }
    // Daemon-filled over the caller: reconnect/create name the minting platform, runner-up a dial URL and a pairing.
    const flow: DeviceSandboxFlow =
        input.op === "reconnect" || input.op === "create"
            ? { ...input, platformUrl: mintingPlatform(services) }
            : input.op === "runner-up"
              ? await (async () => {
                    const parentUrl = services.config.sandbox.publicUrl;
                    if (parentUrl === "") {
                        throw new ORPCError("CONFLICT", {
                            message:
                                "This sandbox has no public address yet, so a runner would have nothing to dial back to. Finish its setup first.",
                        });
                    }
                    // Overlay ships as approved bytes plus sha256, re-checked on the machine; definition ships settings
                    // only, best-effort.
                    const definition = await Promise.resolve()
                        .then(() => settingsDefinition(services))
                        .then((settings) => (Object.keys(settings.settings).length === 0 ? undefined : emitDefinitionToml(settings)))
                        // allow(silent-catch): settings ride along best-effort; the runner is built without them, never refused
                        .catch(() => undefined);
                    // The overlay this sandbox wants, composed now; none is no overlay, and a compose that failed throws, or
                    // the runner would be built without it.
                    const overlay = await composeEnvironment(services);
                    return {
                        ...input,
                        parentUrl,
                        pair: services.runners.mintPairing(input.slug, { host: id }).token,
                        ...(definition !== undefined ? { definition } : {}),
                        ...(overlay === undefined ? {} : { overlay: overlay.content, overlayHash: overlay.hash }),
                    };
                })()
              : input.op === "set-egress"
                ? await withEgressOwnerKeys(services, input, origin)
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
        // In `finally`: a failed or abandoned run still changed the machine, so the next read asks it again.
        stalePull(id);
    }
}

// Updates or restarts the device's agent, the one flow that expects its own transport to die with the process it stops.
// Confirmation is the version changing on the next read, not a terminal frame.
export async function* runDeviceAgentFlow(services: Services, id: string, input: DeviceAgentFlow): AsyncGenerator<DeviceFlowLine> {
    const client = services.hostHub.client(id);
    if (client === undefined) {
        throw new ORPCError("CONFLICT", { message: services.hostHub.offline(id) });
    }
    try {
        for await (const line of await client.runAgentFlow(input, { signal: AbortSignal.timeout(AGENT_FLOW_TIMEOUT_MS) })) {
            yield line;
        }
    } catch (error) {
        // An answer the device's own RPC layer sent — an agent too old to have this route, a call it refused — names
        // something the reader can act on, so it travels as the refusal it is.
        if (error instanceof ORPCError) {
            yield { kind: "error", message: `${error.message} Run \`intentic-machine upgrade\` on that device.` };
            return;
        }
        // Anything else is the transport dying with the process this flow just stopped, which is what working looks
        // like here. No `result` frame: the view reads one as "the device answered", and the abort's own text belongs
        // to the RPC layer, not to anyone reading this page.
        yield { kind: "line", text: `Lost contact with ${id} — that is what restarting its agent does to this connection.` };
    } finally {
        // The agent may be a different build now, and the version change is this flow's answer: the next read asks again.
        stalePull(id);
        // A drop leaves the agent running on the same socket, so no hello re-describes it (device-facts-refresh.ts).
        if (input.op === "forget-unreachable") {
            refreshFactsOnceSettled(services, id);
        }
    }
}
