import { rm } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import type { RemoteAllow, RemoteMonitor, RemoteStartInput, RemoteStartResult } from "@intentic/sandbox-contract/schemas/device-remote";
import { DEV_VERSION } from "@intentic/sandbox-contract/state/versions";
import { ORPCError } from "@orpc/server";
import { type DaemonBase, resolveDaemonBase } from "../../daemon-base.js";
import { MACHINE_VERSION } from "../../version.js";
import { audit } from "../audit.js";
import { type HostLink, readLinks } from "../config.js";
import { machineIndicator, onPauseChanged, type PersonKind, type PersonOnScreen, readPausedAt } from "../indicator.js";
import { SWITCH_LABELS } from "../policy.js";
import { runningBeforeSignIn } from "../session.js";
import { realRemotedIo, REMOTED_BIN_ENV, resolveRemoted } from "./remoted-binary.js";
import { connectRemoted, controlProtocolsOf, remotedEndpoint, remotedLogPath } from "./remoted-control.js";
import {
    allowFrom,
    allowsAnything,
    readRemotedConfig,
    type RemotedConfig,
    type RemotedPerson,
    type RemotedStatus,
    remotedConfigPath,
    remotedStatusPath,
    updateRemotedConfig,
    withAllow,
    withoutUplinks,
    withUplink,
    writeRemotedStatus,
} from "./remoted-files.js";
import { createRemotedProcess, type RemotedControlSeams, type RemotedProcess, type SpawnRemoted } from "./remoted.js";
import { detachRemoted, spawnRemoted } from "./remoted-spawn.js";

/* PEOPLE'S REMOTE ACCESS ON THIS COMPUTER, AS THE AGENT KEEPS IT (2026-11-20). The daemon calls `remoteStart` on a link
   when a person in its editor opens this computer's screen or a terminal, and `remoteStop` when nobody there needs it
   any more. One intentic-remoted serves every link of this environment, one uplink per link, and runs only while some
   link holds one. What each uplink allows is that link's own three switches, read here and nowhere else: a switch
   turned off reaches remoted within a second (the grant's push rewrites its config, which remoted re-reads), and a link
   with all three off, gone or revoked loses its uplink. The secrets ride in remoted.json, never in a log or the audit. */

const { remoteView, remoteControl, remoteTerminal } = SWITCH_LABELS;
export const NOTHING_ALLOWED = `Refused: "${remoteView}", "${remoteControl}" and "${remoteTerminal}" are all switched off for this device. Turn one on in its capability card to let people reach it.`;

// How long remoteStart waits for remoted's uplink to this sandbox to come up before it answers with why not.
const UP_TIMEOUT_MS = 10_000;
// How long an uplink may stay down before the sandbox's address is resolved again: the loopback a sandbox on this
// machine answers on comes and goes with its container, and the public address is the floor.
const RESOLVE_AGAIN_AFTER_MS = 30_000;
const RESOLVE_CHECK_MS = 5_000;

// The link a call came in on: its sandbox (the uplink's id), its grant as of now, and the log its lines go to.
export interface RemoteLink {
    readonly sandboxUrl: string;
    readonly scopes: DeviceScopes;
    readonly log: Log;
}

export interface RemoteSeams {
    // The remoted to start, or a RemotedUnavailable saying why there is none.
    readonly binary: (log: Log) => Promise<string>;
    readonly resolveBase: (sandboxUrl: string) => Promise<DaemonBase>;
    readonly spawn: SpawnRemoted;
    // Adopting a remoted that outlived the agent before this one (remoted.ts); without it remoted is this agent's child.
    readonly control?: RemotedControlSeams;
    // The person's pause, as the `paused` file says it; a pause that cannot be read is a pause.
    readonly paused: () => Promise<boolean>;
    readonly people: (people: readonly PersonOnScreen[], log: Log) => void;
    readonly audit: (entry: { tool: string; ok: boolean; detail: string }) => Promise<void>;
    readonly configPath: string;
    readonly statusPath: string;
    readonly now: () => number;
    readonly upTimeoutMs?: number;
}

export interface Remote {
    readonly start: (link: RemoteLink, input: RemoteStartInput) => Promise<RemoteStartResult>;
    readonly stop: (link: Pick<RemoteLink, "sandboxUrl" | "log">) => Promise<void>;
    // A grant pushed on a link: its uplink's allow rewritten, or the uplink dropped once it allows nothing.
    readonly scopesChanged: (sandboxUrl: string, scopes: DeviceScopes) => Promise<void>;
    // The links this environment holds now, every resident tick: an uplink whose link is gone goes with it. The first
    // call takes up what remoted.json held when the agent last ran.
    readonly keepLinks: (links: readonly HostLink[]) => Promise<void>;
    readonly pausedChanged: () => Promise<void>;
    // The agent is leaving: remoted is left running for the next agent to adopt (or stopped, when it is this agent's
    // child), its uplinks kept for the next agent.
    readonly shutdown: () => Promise<void>;
    readonly status: () => RemotedStatus | undefined;
}

const hostOf = (sandboxUrl: string): string => URL.parse(sandboxUrl)?.host ?? sandboxUrl;

const allowWords = (allow: RemoteAllow): string =>
    `view ${allow.view ? "on" : "off"}, control ${allow.control ? "on" : "off"}, terminals ${allow.terminal ? "on" : "off"}`;

const KINDS: ReadonlySet<string> = new Set<PersonKind>(["view", "control", "terminal"]);

// A person as the notice names them; a kind this agent does not know yet is shown as someone viewing. Pure.
export const onScreen = (person: RemotedPerson): PersonOnScreen => ({
    // SAFETY: checked against the kinds the notice words just above
    kind: KINDS.has(person.kind) ? (person.kind as PersonKind) : "view",
    sandboxUrl: person.uplink,
});

const personKey = (person: RemotedPerson): string => `${person.uplink}\u0000${person.kind}\u0000${person.session}`;

// Who came and who went between two statuses.
export interface PeopleMoved {
    readonly came: readonly RemotedPerson[];
    readonly went: readonly RemotedPerson[];
}

// Pure.
export const peopleMoved = (before: readonly RemotedPerson[], after: readonly RemotedPerson[]): PeopleMoved => {
    const had = new Set(before.map(personKey));
    const has = new Set(after.map(personKey));
    return { came: after.filter((person) => !had.has(personKey(person))), went: before.filter((person) => !has.has(personKey(person))) };
};

// The monitors as the contract has them, whole pixels, whatever else a newer remoted says of them. Pure.
const monitorsOf = (status: RemotedStatus): RemoteMonitor[] =>
    status.monitors.map(({ id, name, x, y, width, height, scale, primary }) => ({
        id,
        name,
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
        scale,
        primary,
    }));

const uplinkIn = (status: RemotedStatus | undefined, id: string) => status?.uplinks.find((uplink) => uplink.id === id);

// Everything one environment's remote access holds between calls, shared by the steps below.
interface RemoteState {
    readonly seams: RemoteSeams;
    readonly log: Log;
    readonly process: RemotedProcess;
    // One change at a time: a start, a stop and a grant arriving together each read what the one before wrote.
    readonly serial: <T>(work: () => Promise<T>) => Promise<T>;
    // The uplinks remoted.json holds, by id; undefined until the file was read.
    held: ReadonlySet<string> | undefined;
    // The last generation each uplink was given, so one dropped and started again within remoted's run never repeats one.
    readonly generations: Map<string, number>;
    // When each uplink's address was last resolved.
    readonly resolvedAt: Map<string, number>;
    urlWatch: NodeJS.Timeout | undefined;
}

// The config with `change` applied and the person's pause as the `paused` file says now, written when it differs.
const writeConfig = async (state: RemoteState, change: (config: RemotedConfig) => RemotedConfig): Promise<RemotedConfig> => {
    // allow(silent-catch): a pause that cannot be read holds, as it does for agents (indicator.ts)
    const paused = await state.seams.paused().catch(() => true);
    const written = await updateRemotedConfig((before) => {
        const changed = change(before);
        return changed.paused === paused ? changed : { ...changed, paused };
    }, state.seams.configPath);
    state.held = new Set(written.uplinks.map((uplink) => uplink.id));
    return written;
};

const loadConfig = async (state: RemoteState): Promise<void> => {
    if (state.held !== undefined) {
        return;
    }
    const config = await readRemotedConfig(state.seams.configPath);
    state.held = new Set(config?.uplinks.map((uplink) => uplink.id) ?? []);
    for (const uplink of config?.uplinks ?? []) {
        state.generations.set(uplink.id, uplink.generation);
    }
};

// Who came and who went, said in the log and the audit, and the notice told whenever it changed.
const watchPeople = (seams: RemoteSeams, log: Log) => {
    let people: readonly RemotedPerson[] = [];
    return (status: RemotedStatus | undefined): void => {
        if (status === undefined) {
            // allow(silent-catch): a status file left behind names a pid that is gone, which `remote status` reads as not running
            void rm(seams.statusPath, { force: true }).catch(() => undefined);
        } else {
            void writeRemotedStatus(status, seams.statusPath);
        }
        const now = status?.people ?? [];
        const { came, went } = peopleMoved(people, now);
        people = now;
        const moves = [...came.map((one) => [one, "opened"] as const), ...went.map((one) => [one, "ended"] as const)];
        for (const [one, verb] of moves) {
            const detail = `a person's ${one.kind} session ${one.session} ${verb}, from ${hostOf(one.uplink)}${one.readOnly === true ? " (read-only)" : ""}`;
            log(`remoted: ${detail}`);
            void seams.audit({ tool: "remote-person", ok: true, detail });
        }
        if (moves.length > 0) {
            seams.people(now.map(onScreen), log);
        }
    };
};

// An uplink down for RESOLVE_AGAIN_AFTER_MS has its sandbox's address resolved again, and rewritten if it moved.
const resolveAgain = async (state: RemoteState): Promise<void> => {
    const now = state.seams.now();
    const stale = (state.process.status()?.uplinks ?? []).filter(
        (uplink) =>
            uplink.state !== "up" &&
            uplink.state !== "withdrawn" &&
            now - uplink.since >= RESOLVE_AGAIN_AFTER_MS &&
            now - (state.resolvedAt.get(uplink.id) ?? 0) >= RESOLVE_AGAIN_AFTER_MS,
    );
    for (const { id } of stale) {
        state.resolvedAt.set(id, now);
        // one sandbox at a time, each a /health probe bounded at 1.5 s
        const { base } = await state.seams.resolveBase(id);
        // each rewrite waits for the change before it
        const moved = await state.serial(async () => {
            let changed = false;
            await writeConfig(state, (before) => {
                const uplink = before.uplinks.find((entry) => entry.id === id);
                changed = uplink !== undefined && uplink.url !== base;
                return uplink === undefined || !changed ? before : withUplink(before, { ...uplink, url: base });
            });
            return changed;
        });
        if (moved) {
            state.log(`remoted: ${hostOf(id)} answers at ${base} now`);
        }
    }
};

const runRemoted = (state: RemoteState, binary: string): void => {
    state.process.ensure(binary);
    state.urlWatch ??= setInterval(
        () => void resolveAgain(state).catch((cause: unknown) => state.log(`remoted: could not resolve a sandbox again (${errorMessage(cause)})`)),
        RESOLVE_CHECK_MS,
    );
    state.urlWatch.unref();
};

const haltRemoted = async (state: RemoteState): Promise<void> => {
    clearInterval(state.urlWatch);
    state.urlWatch = undefined;
    await state.process.stop();
};

// Stops remoted once no uplink is left.
const settleRemoted = async (state: RemoteState): Promise<void> => {
    if (state.held?.size === 0 && state.process.running()) {
        await haltRemoted(state);
    }
};

// What remoted.json held when the agent last ran, kept where its link still exists and still allows something, and
// remoted started again for it.
const resume = async (state: RemoteState, links: readonly HostLink[]): Promise<void> => {
    await loadConfig(state);
    if (state.held?.size === 0) {
        return;
    }
    const byUrl = new Map(links.map((link) => [link.sandboxUrl, link]));
    const kept = await writeConfig(state, (config) => ({
        ...config,
        uplinks: config.uplinks.flatMap((uplink) => {
            const link = byUrl.get(uplink.id);
            const allow = link === undefined ? undefined : allowFrom(link.scopes);
            return allow === undefined || !allowsAnything(allow) ? [] : [{ ...uplink, allow }];
        }),
    }));
    if (kept.uplinks.length === 0) {
        state.log("remoted: the uplinks it held are gone with their links or their switches, so it is not started again");
        return;
    }
    // Queued, not awaited: a remoted to fetch first must not hold the tick that dials every link.
    void state.serial(async () => {
        if (state.process.running() || state.held?.size === 0) {
            return;
        }
        try {
            runRemoted(state, await state.seams.binary(state.log));
            state.log(`remoted: started again for ${kept.uplinks.map((uplink) => hostOf(uplink.id)).join(", ")}`);
        } catch (error) {
            state.log(`remoted: could not start again (${errorMessage(error)}); the next remoteStart tries again`);
        }
    });
};

// Writes this link's uplink, a generation on from its last, and starts remoted if it is not running.
const beginUplink = async (state: RemoteState, link: RemoteLink, input: RemoteStartInput, allow: RemoteAllow): Promise<void> => {
    await loadConfig(state);
    let binary: string | undefined;
    if (!state.process.running()) {
        try {
            binary = await state.seams.binary(link.log);
        } catch (error) {
            throw new ORPCError("PRECONDITION_FAILED", { message: `Refused: people cannot reach this computer: ${errorMessage(error)}` });
        }
    }
    const { base } = await state.seams.resolveBase(link.sandboxUrl);
    state.resolvedAt.set(link.sandboxUrl, state.seams.now());
    const id = link.sandboxUrl;
    await writeConfig(state, (config) => {
        const generation = Math.max(config.uplinks.find((uplink) => uplink.id === id)?.generation ?? 0, state.generations.get(id) ?? 0) + 1;
        state.generations.set(id, generation);
        const { device, uplinkToken, mediaKey, iceServers } = input;
        return withUplink(config, { id, url: base, device, uplinkToken, mediaKey, allow, generation, ...(iceServers === undefined ? {} : { iceServers }) });
    });
    if (binary !== undefined) {
        runRemoted(state, binary);
    }
};

const startRemote = async (state: RemoteState, link: RemoteLink, input: RemoteStartInput): Promise<RemoteStartResult> => {
    const { seams } = state;
    const allow = allowFrom(link.scopes);
    const asked = `${hostOf(link.sandboxUrl)} as device ${input.device}, ${allowWords(allow)}`;
    if (!allowsAnything(allow)) {
        void seams.audit({ tool: "remoteStart", ok: false, detail: `${asked}: refused, every people switch is off` });
        throw new ORPCError("FORBIDDEN", { message: NOTHING_ALLOWED });
    }
    try {
        await state.serial(async () => await beginUplink(state, link, input, allow));
    } catch (error) {
        void seams.audit({ tool: "remoteStart", ok: false, detail: `${asked}: ${errorMessage(error)}` });
        throw error instanceof ORPCError ? error : new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(error) });
    }
    const timeoutMs = seams.upTimeoutMs ?? UP_TIMEOUT_MS;
    // Up at the generation just written, not an `up` left over from the uplink's previous start.
    const written = state.generations.get(link.sandboxUrl) ?? 0;
    const up = await state.process.waitFor((status) => {
        const uplink = uplinkIn(status, link.sandboxUrl);
        return uplink?.state === "up" && (uplink.generation ?? written) >= written;
    }, timeoutMs);
    if (up === undefined) {
        const last = uplinkIn(state.process.status(), link.sandboxUrl);
        const why =
            last === undefined ? "remoted has not reported it yet" : `it is ${last.state}${last.error === undefined ? "" : `: ${last.error}`}`;
        void seams.audit({ tool: "remoteStart", ok: false, detail: `${asked}: not up within ${timeoutMs / 1_000}s (${why})` });
        link.log(`${link.sandboxUrl}: remoted's uplink did not come up in time (${why}); it keeps dialling`);
        throw new ORPCError("GATEWAY_TIMEOUT", {
            message: `intentic-remoted on this computer did not connect to the sandbox within ${timeoutMs / 1_000} s (${why}). It keeps trying.`,
        });
    }
    void seams.audit({ tool: "remoteStart", ok: true, detail: `${asked}: remoted ${up.version} up` });
    link.log(`${link.sandboxUrl}: people's remote access is up (${allowWords(allow)}), through remoted ${up.version}`);
    return { version: up.version, allow, monitors: monitorsOf(up), environments: up.environments };
};

const stopRemote = async (state: RemoteState, link: Pick<RemoteLink, "sandboxUrl" | "log">): Promise<void> => {
    await state.serial(async () => {
        await loadConfig(state);
        await writeConfig(state, (config) => withoutUplinks(config, new Set([link.sandboxUrl])));
        await settleRemoted(state);
    });
    void state.seams.audit({ tool: "remoteStop", ok: true, detail: `${hostOf(link.sandboxUrl)}: its uplink is dropped` });
    link.log(`${link.sandboxUrl}: people's remote access stopped`);
};

const changeScopes = async (state: RemoteState, sandboxUrl: string, scopes: DeviceScopes): Promise<void> => {
    if (state.held?.has(sandboxUrl) !== true) {
        return;
    }
    const allow = allowFrom(scopes);
    await state.serial(async () => {
        await writeConfig(state, (config) => withAllow(config, sandboxUrl, allow));
        await settleRemoted(state);
    });
    const said = allowsAnything(allow) ? `now ${allowWords(allow)}` : "dropped, every people switch is off";
    state.log(`remoted: ${hostOf(sandboxUrl)}'s uplink ${said}`);
    void state.seams.audit({ tool: "remoteScopes", ok: true, detail: `${hostOf(sandboxUrl)}: uplink ${said}` });
};

const keepLinks = async (state: RemoteState, links: readonly HostLink[]): Promise<void> => {
    if (state.held === undefined) {
        await state.serial(async () => await resume(state, links));
        return;
    }
    const linked = new Set(links.map((link) => link.sandboxUrl));
    const gone = new Set([...state.held].filter((id) => !linked.has(id)));
    if (gone.size === 0) {
        // A remoted started again after an exit (or by another hand) while no uplink is left is stopped here too.
        await state.serial(async () => await settleRemoted(state));
        return;
    }
    await state.serial(async () => {
        await writeConfig(state, (config) => withoutUplinks(config, gone));
        await settleRemoted(state);
    });
    state.log(`remoted: dropped the uplinks of ${[...gone].map(hostOf).join(", ")}, no longer linked`);
};

export const createRemote = (seams: RemoteSeams, log: Log): Remote => {
    let queue: Promise<unknown> = Promise.resolve();
    const process = createRemotedProcess({
        spawn: seams.spawn,
        control: seams.control,
        configPath: seams.configPath,
        log,
        onStatus: watchPeople(seams, log),
        now: seams.now,
    });
    const state: RemoteState = {
        seams,
        log,
        process,
        serial: <T>(work: () => Promise<T>): Promise<T> => {
            const turn = queue.then(work);
            // allow(silent-catch): the turn's own caller hears its failure; the queue only waits for it
            queue = turn.catch(() => undefined);
            return turn;
        },
        held: undefined,
        generations: new Map(),
        resolvedAt: new Map(),
        urlWatch: undefined,
    };
    return {
        start: async (link, input) => await startRemote(state, link, input),
        stop: async (link) => await stopRemote(state, link),
        scopesChanged: async (sandboxUrl, scopes) => await changeScopes(state, sandboxUrl, scopes),
        keepLinks: async (links) => await keepLinks(state, links),
        pausedChanged: async () => {
            if (state.held !== undefined && state.held.size > 0) {
                await state.serial(async () => void (await writeConfig(state, (config) => config)));
            }
        },
        // Not queued: the agent is leaving, and a remoteStart still waiting on a download must not hold it here.
        shutdown: async () => {
            clearInterval(state.urlWatch);
            state.urlWatch = undefined;
            await process.release();
        },
        status: () => process.status(),
    };
};

const realSeams = (): RemoteSeams => ({
    binary: async (log) => await resolveRemoted(MACHINE_VERSION, realRemotedIo(log)),
    // Proven with the link's own token, the credential the device holds for that sandbox (../../daemon-base.ts): an
    // uplink token remoted carries to a stranger on the loopback port would be a person's session handed to it.
    resolveBase: async (sandboxUrl) => await resolveDaemonBase(sandboxUrl, (await readLinks()).find((link) => link.sandboxUrl === sandboxUrl)?.token),
    spawn: spawnRemoted,
    control: {
        endpoint: remotedEndpoint(),
        connect: connectRemoted,
        detach: detachRemoted(remotedLogPath),
        protocolsOf: controlProtocolsOf,
        // A release's remoted is its agent's version; a source build or an override is whatever was built.
        build: MACHINE_VERSION === DEV_VERSION || (process.env[REMOTED_BIN_ENV] ?? "") !== "" ? undefined : MACHINE_VERSION,
        // Before sign-in its remoted has no desktop: it ends with this agent, at the handover, and is never adopted.
        detachable: () => !runningBeforeSignIn(),
    },
    paused: async () => (await readPausedAt()) !== undefined,
    // Before anyone signs in there is no screen to put a notice on (session.ts); terminals work there all the same.
    people: (people, log) => {
        if (!runningBeforeSignIn()) {
            void machineIndicator().people(people, log);
        }
    },
    audit,
    configPath: remotedConfigPath,
    statusPath: remotedStatusPath,
    now: Date.now,
});

let machine: Remote | undefined;

// This environment's one remoted, its lines in `log` (the resident's, which asks first).
export const machineRemote = (log: Log): Remote => {
    if (machine === undefined) {
        const remote = createRemote(realSeams(), log);
        onPauseChanged(
            () => void remote.pausedChanged().catch((cause: unknown) => log(`remoted: could not pass the pause on (${errorMessage(cause)})`)),
        );
        machine = remote;
    }
    return machine;
};
