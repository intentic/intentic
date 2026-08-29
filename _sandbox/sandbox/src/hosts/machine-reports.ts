import {
    type Computer,
    type ComputerGap,
    type HostSummary,
    type MachineFlowLine,
    type MachineReport,
    MachineReportSchema,
    type MachineSandbox,
    type MachineSandboxFlow,
    MachineSandboxSchema,
} from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Services } from "../composition.js";
import { approvedPath } from "../environment/environment.js";
import { enrolledFleet } from "../platform/sync.js";
import { emitDefinitionToml, settingsDefinition } from "../portability/definition.js";
import { hostSummaries } from "./host.routes.js";

/* THE COMPUTERS VIEW'S DATA, every machine on the other end of this sandbox, however it is reachable.
 *
 * Two independent doors, and this is where they meet:
 *
 *   • The desktop-sync agent VOLUNTEERS its report on the ports poll it already makes. Costs the daemon nothing,
 *     needs no capability, and is how most users' machines appear here.
 *   • A `host` capability lets the daemon ASK. That is the only sanctioned channel from a sandbox to a machine,
 *     the docker socket is never mounted (see @intentic/sandbox-run's posture comment) and the docker capability
 *     grants a NESTED engine, so a sandbox can never see its siblings by itself. It adds the two things the
 *     volunteered report cannot carry: the machine's containers, and machines with no sync agent at all.
 *
 * The pulled half deliberately runs the SAME `intentic-machine status --json` the desktop app spawns, rather
 * than a second implementation of the same questions (the machine report rides in that status as its `sync`
 * half). One producer is what stops the terminal answer and the two on-screen answers from drifting, the
 * argument the desktop app already makes for spawning connect.sh. */

/* How old a served reading may be before the machine is asked again. NOT how long a reader waits: the answer
 * comes out of this map either way and the refresh runs behind it (see pullCached), so this is the machine's
 * poking cadence and nothing else.
 *
 * It used to be 10s, which was exactly the browser's own poll interval, and a request that itself took seconds:
 * so the entry had always just expired by the time the next poll arrived, every poll re-poked every machine, and
 * the cache never once hit. A cadence has to be longer than the poll it is meant to absorb. */
const PULL_TTL_MS = 30_000;

/* THE DEADLINE ON ONE READING, and it is a real one now.
 *
 * This number used to be handed to the machine as its own `run_command` budget and nowhere else, so the only
 * deadline this side had was the hub's fifteen-MINUTE backstop (host-hub.ts CALL_TIMEOUT_MS), which is sized for
 * a tool call an agent meant to make. A socket that was gone but not closed therefore held the whole HTTP
 * response: the observed tail on this route ran to 45, 65, 91 seconds. Now the call carries the signal.
 *
 * The machine's own budget sits BELOW it by about a round trip, so a command that overruns comes back as the
 * machine's own answer rather than being cut off mid-sentence by this side. */
const COMMAND_TIMEOUT_MS = 5_000;
const PULL_TIMEOUT_MS = 8_000;

// The ceiling on one management flow. Far above what any of them should take, an update on a slow connection
// pulls a multi-gigabyte image, because the machine bounds its own work and this only ever catches a socket that
// died without closing. A flow cut off here has still happened; it is the WATCHING that ends, which is why the
// view re-reads the fleet afterwards rather than trusting what it last saw.
const FLOW_TIMEOUT_MS = 60 * 60 * 1000;

export type PullResult = { readonly report: MachineReport } | { readonly gap: ComputerGap };

/* ONE MACHINE'S LAST READING, plus whatever refresh is currently on the wire for it.
 *
 * `inflight` is the half that was missing, and its absence was not a nicety: `pullCached` used to check the map,
 * await a pull, then write it, so every reader that arrived during those seconds started a pull of its own. A
 * second browser tab, the desktop app, another member of the sandbox and the poll landing on top of a manual
 * refetch were four simultaneous round trips to the same laptop asking the same question. */
interface PullEntry {
    /** When `result` landed. Zero until the first reading of this daemon's life does. */
    at: number;
    /** The last complete reading, served while a newer one is being fetched. */
    result: PullResult | undefined;
    /** The refresh on the wire, so however many readers arrive, the machine is asked once. */
    inflight: Promise<PullResult> | undefined;
}

const pulled = new Map<string, PullEntry>();

/* `run_command` answers in PROSE, an exit line, then the streams under `--- stdout ---` fences (see the host
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
        // The machine report is the `sync` half of the agent's status envelope (the rest of the envelope — the
        // computer links — is the daemon's own knowledge already, so only this half is read).
        const report = MachineReportSchema.safeParse((parsed as { sync?: unknown }).sync);
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

const callTool = async (
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

const MachineSandboxRowsSchema = z.array(MachineSandboxSchema);

/* The machine's containers, which the sync agent never reports (a sync agent enumerating a machine's other
 * sandboxes to one of them is the disclosure the whole design avoids by construction). Asking through a host
 * capability is different: the owner ticked a switch that says this sandbox may look there.
 *
 * Asked of the machine's own `list_sandboxes` tool, which owns the sidecar merging and answers the row JSON
 * directly, the machine is the one producer of "what runs on me", for this reader, for the agent and for its
 * own manage_sandbox. An agent too old to have the tool refuses it, which reads here exactly like a machine
 * that runs no sandboxes, and its age is already visible on the row (agents.host). */
export const sandboxesFromTool = (text: string, refused: boolean): MachineSandbox[] => {
    if (refused) {
        return [];
    }
    const rows = MachineSandboxRowsSchema.safeParse(safeJson(text.trim()));
    return rows.success ? rows.data : [];
};

/* Ask one connected machine what it looks like. Every failure mode is a NAMED gap rather than an absence, because
 * each is a different errand for whoever is reading the tab.
 *
 * THE TWO QUESTIONS GO TOGETHER. They are independent, and asking the second only after the first came back made
 * every reporting machine cost two round trips end to end where it needed one: at the 1-3s a round trip to a
 * laptop actually costs, that was half this route's latency for nothing. The `no-agent`/`scope-off` decision is
 * still the status call's alone; the fleet answer is simply already in hand by the time it is made, and a machine
 * that refused it (or is too old to have the tool) reads exactly as one running no containers, which is the rule
 * sandboxesFromTool already stated. */
const pull = async (services: Services, id: string): Promise<PullResult> => {
    // One deadline over both calls: the reading is what has a budget, not either half of it.
    const signal = AbortSignal.timeout(PULL_TIMEOUT_MS);
    const [status, fleet] = await Promise.all([
        callTool(services, id, "run_command", { command: "intentic-machine status --json", timeoutMs: COMMAND_TIMEOUT_MS }, signal),
        callTool(services, id, "list_sandboxes", {}, signal).catch(() => ({ text: "", refused: true })),
    ]);
    if (status.refused) {
        // The host agent refuses out-of-scope calls as a value naming the switch. Anything else refused here is
        // still, from the reader's side, "this machine would not answer", and the tab's remedy is the same.
        return { gap: "scope-off" };
    }
    const report = reportFrom(status.text);
    if (report === undefined) {
        return { gap: "no-agent" };
    }
    const sandboxes = sandboxesFromTool(fleet.text, fleet.refused);
    return { report: { ...report, sandboxes, agents: { ...report.agents, host: services.hostHub.state(id).version } } };
};

// One refresh for this machine, however many readers wanted it, stamped when it LANDS rather than when it
// started: `at` is the age of the reading being served, and a pull that took six seconds is six seconds of that
// age already spent.
const refresh = (services: Services, id: string, entry: PullEntry): Promise<PullResult> => {
    const inflight = services.perf
        .track("computers.pull", { id }, () => pull(services, id))
        // Never rejects, so a caller that walks away from it (the stale-serving path below) leaves nothing
        // unhandled behind. A machine that would not answer within the deadline is offline as far as this reads.
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

/* WHAT THIS MACHINE LOOKED LIKE, ANSWERED FROM MEMORY, with the refresh running behind the answer.
 *
 * This is the whole of the Computers view's latency fix. The route used to be a live fan-out: a reader waited on
 * a round trip to every one of their laptops, and the measured cost of that was a p50 of ~9.8s with a tail past a
 * minute. Nothing about it needed to be synchronous. A reading is a snapshot of somebody's computer that carries
 * its own `capturedAt`, the view already prints "Last heard from ..." over it, and the machines volunteer reports
 * of their own besides: serving the last one instantly and asking again behind it costs the reader nothing true.
 *
 * Only a machine this daemon has never once read blocks, and that one is bounded by PULL_TIMEOUT_MS. */
const pullCached = async (services: Services, id: string): Promise<PullResult> => {
    const entry = pulled.get(id) ?? { at: 0, result: undefined, inflight: undefined };
    pulled.set(id, entry);
    if (entry.result !== undefined && Date.now() - entry.at < PULL_TTL_MS) {
        return entry.result;
    }
    const inflight = entry.inflight ?? refresh(services, id, entry);
    // Stale but serving. The refresh above is deliberately not awaited: it lands in the map and the next reader
    // (or this one's next poll, ten seconds out) gets it.
    return entry.result ?? (await inflight);
};

/* WHICH OS, in the one vocabulary the view renders, the capability cards' own slugs (see the `computers`
 * extension). A sync report states the same fact in Node's spelling, because that is what `os.platform()`
 * returns on the machine, so the two are folded together here rather than in the browser: "win32" is a token
 * this side knows the meaning of, and a view that has to know it too is a view that has to be updated when a
 * platform is added. An unrecognised token passes through as itself, better a strange word on the row than a
 * machine that claims no OS at all. */
const PLATFORM_SLUGS: Record<string, string> = { win32: "windows", darwin: "macos", linux: "linux" };

// The capability's card is authoritative when there is one: the owner picked it, and it is known whether or not
// the machine has ever answered anything.
const platformOf = (declared: string | undefined, report: MachineReport | undefined): string | undefined =>
    declared ?? (report === undefined ? undefined : (PLATFORM_SLUGS[report.os] ?? report.os));

/* THE RECONCILIATION, as a pure function of the three things that feed it, which machines are enrolled, what
 * they volunteered, and what each host capability answered. Pure because this is the part with a judgement in it,
 * and a judgement is worth testing without a WebSocket, a tmpdir and a capability store standing behind it.
 *
 * It is deliberately conservative: a sync enrollment and a host capability collapse into ONE row only when both
 * produced a report and those reports agree on the hostname. Anything weaker is a guess, and the guess that goes
 * wrong merges two collaborators' laptops into a single row on a shared sandbox. */
export const mergeComputers = (
    enrolled: readonly string[],
    volunteered: readonly { machine: string; report: MachineReport }[],
    // The host's whole summary, not just its id and liveness: what the machine said about itself at connect is
    // the only description a row with no report has, and it is already sitting in the hub's memory.
    hosts: readonly { host: HostSummary; result: PullResult }[],
): Computer[] => {
    // Driven by the ENROLLMENT list, not the report list: a machine that has never posted still gets a row, which
    // is the whole difference between "your laptop's agent is too old to report" and the sandbox quietly
    // pretending the laptop is not there.
    const rows: Computer[] = enrolled.map((machine) => {
        const report = volunteered.find((entry) => entry.machine === machine)?.report;
        const platform = platformOf(undefined, report);
        return {
            key: report?.hostname ?? machine,
            label: machine,
            syncEnrolled: true,
            ...(platform === undefined ? {} : { platform }),
            ...(report === undefined ? {} : { report }),
        };
    });

    for (const { host, result } of hosts) {
        const report = "report" in result ? result.report : undefined;
        // Everything this side knows about the machine itself, as opposed to what it is doing for this sandbox.
        const platform = platformOf(host.platform, report);
        const identity = {
            hostId: host.id,
            online: host.online,
            ...(platform === undefined ? {} : { platform }),
            ...(host.facts === undefined ? {} : { facts: host.facts }),
            ...(host.version === undefined ? {} : { hostAgent: host.version }),
            ...(host.lastSeen === undefined ? {} : { lastSeen: host.lastSeen }),
        };
        const existing = report === undefined ? undefined : rows.find((row) => row.key === report.hostname);
        if (existing !== undefined) {
            // The same box through both doors. The pulled report wins because it alone carries the containers;
            // the sync-enrolled label stays because it is the name this sandbox has always shown for the machine.
            Object.assign(existing, { ...identity, report });
            continue;
        }
        rows.push({
            key: report?.hostname ?? host.id,
            label: host.id,
            syncEnrolled: false,
            ...identity,
            ...(report === undefined ? { gap: "gap" in result ? result.gap : "offline" } : { report }),
        });
    }

    // An enrolled machine with no report says so, rather than rendering as a computer that has no folders and no
    // ports, which is exactly what one running an agent too old to report would otherwise look like.
    for (const row of rows) {
        if (row.report === undefined && row.gap === undefined) {
            row.gap = "unreported";
        }
    }
    return rows;
};

/* The IO half: read both doors, ask every host that is actually up, and hand the three lists to the merge above.
 *
 * Timed as one span so the route's cost is attributable in logs/perf.jsonl rather than only visible as the
 * http.request that contains it: `computers.read` is this reconciliation, `computers.pull` is one round trip to
 * one machine, and the two rows together say whether a slow tab is the daemon or somebody's laptop. Which is the
 * distinction that took a day of log archaeology to establish the first time. */
export const computers = async (services: Services): Promise<Computer[]> =>
    services.perf.track("computers.read", {}, async () => {
        const hosts = await hostSummaries(services);
        const answered = await Promise.all(
            hosts.map(async (host) => ({
                host,
                // An offline machine is never asked: the call would hang until the deadline to produce an answer
                // that is already knowable.
                result: host.online ? await pullCached(services, host.id) : ({ gap: "offline" } as const),
            })),
        );
        const fleet = await enrolledFleet(services.config.historyRoot);
        return mergeComputers(fleet.machines, fleet.reports, answered);
    });

/* One management action on one machine's sandbox, the Computers view's buttons, relayed to the machine and
 * narrated back as it happens.
 *
 * Streamed rather than awaited because the slowest of these takes MINUTES: an update pulls an image and recreates
 * a container, and a button that spins in silence for that long is indistinguishable from one that is broken.
 * The lines are the machine's own, verbatim, this side adds no progress model of its own, exactly as the desktop
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
            message: `"${id}" is not connected right now, the computer is asleep, offline, or its agent isn't running.`,
        });
    }
    /* STARTING A RUNNER IS THE ONE OP THIS SIDE ADDS TO (runners/, docs/remote-runners-plan.md at the
     * workspace root): the caller names a machine and a name, and the DAEMON supplies the two things that
     * make a runner, where to dial and a single-use pairing bound to that name. Neither is ever in the
     * browser's hands: a pairing is a key to this sandbox's dispatch surface, and the only hop it needs to
     * make is the one to the machine that is about to spend it.
     *
     * A sandbox with no public URL cannot be a parent at all: the runner has nothing to dial back to, so the
     * refusal is here, before a container exists on somebody's computer with no way home. */
    const flow: MachineSandboxFlow =
        input.op === "runner-up"
            ? await (async () => {
                  const parentUrl = services.config.sandbox.publicUrl;
                  if (parentUrl === "") {
                      throw new ORPCError("CONFLICT", {
                          message: "This sandbox has no public address yet, so a runner would have nothing to dial back to. Finish its setup first.",
                      });
                  }
                  /* THE PARENT'S SHAPE RIDES ALONG, so the runner starts as this sandbox's twin rather than a
                   * bare base image (docs/remote-runners-plan.md §7 — until this, "outdated → rebuild" was
                   * structurally dead for the overlay half: the recipe lived only on this volume, and nothing
                   * carried it to the machine).
                   *
                   * The overlay travels as the APPROVED composed bytes plus their sha256 — the exact pair
                   * `ic sandbox rebuild` verifies — because this owner already approved those bytes and the
                   * runner has no owner of its own to re-approve them: approval by provenance, checked
                   * byte-exact again on the machine before anything builds. The definition is scoped to
                   * settings before it leaves (capabilities and secret names never ride to a runner), and an
                   * all-defaults sandbox sends none at all rather than an empty document. Both best-effort in
                   * derivation: a runner without its twin's shape still runs turns, the drift lines say the rest. */
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
                      pair: services.runners.mintPairing(input.slug, id).token,
                      ...(definition !== undefined ? { definition } : {}),
                      ...(overlay !== undefined && overlay !== "" ? { overlay, overlayHash: sha256Hex(overlay) } : {}),
                  };
              })()
            : input;
    try {
        // The machine bounds its own work; this ceiling only ever catches a socket that is gone but not closed.
        for await (const line of await client.runSandboxFlow(flow, { signal: AbortSignal.timeout(FLOW_TIMEOUT_MS) })) {
            /* A RUNNER THAT IS GONE FROM THE MACHINE MUST GO FROM HERE TOO. Its enrollment is a durable token
             * for a container that no longer exists, and leaving it behind means a list with a ghost in it and
             * a placement the picker still offers. Only on the machine's own `result`: a removal that failed
             * left the container running, and revoking its way home would strand a working runner. */
            if (line.kind === "result" && input.op === "runner-remove") {
                services.runnerHub.disconnect(input.slug, "this runner was removed from its machine");
                await services.runners.revoke(input.slug);
            }
            yield line;
        }
    } finally {
        /* In `finally` rather than after the loop, because the interesting cases are the ones that do not reach
         * it: a removal that failed halfway still changed the machine, and a reader who navigated away mid-update
         * must not come back to a cache that predates it.
         *
         * DELETED rather than aged out, which is the one place this route waits on a machine on purpose: with no
         * entry left there is nothing to serve stale, so the re-read that follows a button blocks on a real
         * answer. That is exactly what somebody who just pressed Stop is owed. */
        pulled.delete(id);
    }
}
