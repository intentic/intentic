import type { EngineChannel, EngineId, EngineRow, EnginesView } from "@intentic/sandbox-contract";
import { ENGINE_IDS, isNewer } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { opt } from "../agent/run/opt.js";
import type { BootRole } from "../agent/providers/provider-module.js";
import { refreshClaudeSdk } from "../runtimes/claude/claude-sdk.js";
import { blessedEntry, blessedList, blessedListReadAt, blessedListSource, lowestSatisfying, targetVersion } from "./engine-channel.js";
import { ENGINE_DESCRIPTORS, engineDescriptor } from "./engine-descriptors.js";
import { type EngineInstallOutcome, installEngine, isEngineInstalling } from "./engine-install.js";
import { engineChannel, readEngineChannels, setEngineChannel, DEFAULT_CHANNEL } from "./engine-policy.js";
import { forgetEngineResolution, resolveEngine } from "./engine-resolve.js";
import {
    activateVersion,
    deactivate,
    engineDiskBytes,
    engineVersionDir,
    installedVersions,
    quarantineVersion,
    readEngineState,
} from "./engine-store.js";

// The five verbs the card and daily check share:
// - view: what each engine runs, its channel's target, and the way back.
// - converge: installs what the channel asks for when that isn't already running; the daily check is this, over every
//   engine.
// - update: converges one engine now, or installs an owner-named version to get past a floor the blessed list has not
//   caught up with.
// - revert: goes back to the version kept behind the current one, or the image's copy.
// - channel: writes the standing answer, acting on it at once only for `image`.
// A version outside the channel only ever arrives through the explicit update-anyway path; converge auto-installs
// everything else.

export interface EngineHost {
    readonly workspace: { readonly root: string };
    readonly logger: Logger;
}

// Installer is a parameter on every verb, defaulting to the store's; the seam lets a suite drive the decisions here
// without a real download, and without confusing "decided not to" with "installed quickly".
export type EngineInstaller = (id: EngineId, version: string) => Promise<EngineInstallOutcome>;

const updating = new Set<EngineId>();

const rowOf = async (root: string, id: EngineId): Promise<EngineRow> => {
    const descriptor = engineDescriptor(id);
    const [baked, state, resolved, channel, blessed, disk] = await Promise.all([
        descriptor.baked(),
        readEngineState(id),
        resolveEngine(id),
        engineChannel(root, id),
        blessedEntry(id).then((entry) => entry?.blessed),
        engineDiskBytes(id),
    ]);
    const running = resolved.source === "store" ? resolved.version : baked;
    const target = await targetVersion(id, channel, state);
    return {
        id,
        label: descriptor.label,
        running: { ...opt("version", running), source: resolved.source },
        ...opt("baked", baked),
        channel,
        // An offer exists only when it differs from what's running; a matching channel is steady state, not pending.
        ...opt(
            "offered",
            target === undefined || target === running ? undefined : { version: target, blessed: blessed !== undefined && blessed === target },
        ),
        ...opt("blessed", blessed),
        ...opt("previous", state.previous),
        ...opt("installing", updating.has(id) || isEngineInstalling(id) ? true : undefined),
        quarantined: [...state.quarantined],
        diskBytes: disk,
    };
};

export const enginesView = async (host: EngineHost): Promise<EnginesView> => {
    // One list read for the whole view; five independent row reads would be five conditional requests.
    await blessedList();
    const engines = await Promise.all(ENGINE_IDS.map((id) => rowOf(host.workspace.root, id)));
    return {
        engines,
        listSource: blessedListSource(),
        ...opt("listReadAt", blessedListReadAt()),
        ...opt("checkedAt", lastCheckedAt),
    };
};

// When the daily check last ran, in-process; a restart has nothing to report until it runs again.
let lastCheckedAt: string | undefined;

export interface EngineApplied {
    readonly ok: true;
    readonly version: string;
    readonly source: "image" | "store";
    readonly fromNextTurn: boolean;
}

// Installs what the channel asks for when that isn't already running; returns undefined for nothing to do, the daily
// check's usual answer.
const convergeEngine = async (host: EngineHost, id: EngineId, install: EngineInstaller): Promise<EngineApplied | undefined> => {
    const channel = await engineChannel(host.workspace.root, id);
    if (channel.kind === "image") {
        // Not a no-op: switching to image while the store is active must land on the baked copy by the next turn.
        const state = await readEngineState(id);
        if (state.active === undefined) {
            return undefined;
        }
        await deactivate(id);
        forgetEngineResolution(id);
        return { ok: true, version: (await engineDescriptor(id).baked()) ?? "image", source: "image", fromNextTurn: true };
    }
    const state = await readEngineState(id);
    const target = await targetVersion(id, channel, state);
    // Compared against what's running, not just `active`; a fresh box's baked version already satisfies blessed.
    const running = state.active ?? (await engineDescriptor(id).baked());
    if (target === undefined || target === running) {
        return undefined;
    }
    return apply(host, id, target, install);
};

// Installs one version and makes it current: no target means whatever the channel asks for, a version is a deliberate
// unblessed pick, and a floor (the turn-failed path) is resolved here to the lowest one that clears it.
export const updateEngine = async (
    host: EngineHost,
    id: EngineId,
    target?: { version?: string; floor?: string },
    install: EngineInstaller = installEngine,
): Promise<EngineApplied | undefined> => {
    updating.add(id);
    try {
        if (target?.version !== undefined) {
            return await apply(host, id, target.version, install);
        }
        if (target?.floor !== undefined) {
            const version = await versionForFloor(id, target.floor);
            if (version === undefined) {
                // Nothing published satisfies it, or the registry was unreachable; refuse rather than guess a version.
                throw new Error(`no published ${id} version is at or above ${target.floor}`);
            }
            const applied = await apply(host, id, version, install);
            await assertFloorCleared(host, id, version, target.floor);
            return applied;
        }
        return await convergeEngine(host, id, install);
    } finally {
        updating.delete(id);
    }
};

// Confirms the floor was actually cleared, since picking the version rested on an assumption about the provider's
// numbering. A copy that falls short is quarantined and rolled back instead of left claiming success.
const assertFloorCleared = async (host: EngineHost, id: EngineId, version: string, floor: string): Promise<void> => {
    const descriptor = engineDescriptor(id);
    if (descriptor.reportedVersion === undefined) {
        return;
    }
    const prefix = engineVersionDir(id, version);
    const reported = await descriptor.reportedVersion(prefix);
    if (reported !== undefined && (reported === floor || isNewer(reported, floor))) {
        return;
    }
    const reason = `${version} reports itself as ${reported ?? "an unknown version"}, which does not meet the ${floor} the provider requires`;
    await quarantineVersion(id, version, reason, new Date().toISOString());
    forgetEngineResolution(id);
    host.logger.warn({ engine: id, version, floor, reported }, "engine install did not clear the floor");
    throw new Error(reason);
};

const apply = async (host: EngineHost, id: EngineId, version: string, install: EngineInstaller): Promise<EngineApplied> => {
    const outcome = await install(id, version);
    if (!outcome.ok) {
        host.logger.warn({ engine: id, version, reason: outcome.reason }, "engine install refused");
        throw new Error(outcome.reason);
    }
    host.logger.info({ engine: id, version, reused: outcome.reused }, "engine version active");
    return { ok: true, version, source: "store", fromNextTurn: true };
};

// Back to the version kept behind this one, or the image's copy when there is none; both are pointer moves, safe when
// the network is the problem.
export const revertEngine = async (host: EngineHost, id: EngineId): Promise<EngineApplied> => {
    const state = await readEngineState(id);
    const previous = state.previous;
    if (previous !== undefined && (await installedVersions(id)).includes(previous)) {
        await activateVersion(id, previous);
        forgetEngineResolution(id);
        host.logger.info({ engine: id, version: previous }, "engine reverted");
        return { ok: true, version: previous, source: "store", fromNextTurn: true };
    }
    await deactivate(id);
    forgetEngineResolution(id);
    const baked = await engineDescriptor(id).baked();
    host.logger.info({ engine: id, ...opt("version", baked) }, "engine reverted to the image's copy");
    // `image` stands in when a baked version can't be named (a PATH binary); the row still needs an answer.
    return { ok: true, version: baked ?? "image", source: "image", fromNextTurn: true };
};

// Writes the standing answer and converges immediately only when no download is needed: switching to `image` takes
// effect at once, the other three wait for Update or the daily check.
export const setChannel = async (host: EngineHost, id: EngineId, channel: EngineChannel): Promise<EngineChannel> => {
    const stored = await setEngineChannel(host.workspace.root, id, channel);
    if (stored.kind === "image") {
        await convergeEngine(host, id, installEngine);
    }
    return stored;
};

// The lowest published version that clears a floor the sandbox was just refused by; offered as a click, never taken
// automatically, since unblessed versions need a person's consent.
const versionForFloor = async (id: EngineId, floor: string): Promise<string | undefined> => {
    const entry = await blessedEntry(id);
    // If the list has already caught up, the blessed version is the answer; no unblessed step needed.
    if (entry !== undefined && (entry.blessed === floor || isNewer(entry.blessed, floor))) {
        return entry.blessed;
    }
    return lowestSatisfying(id, floor);
};

const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
// Delayed past boot so an engine check does not race the boot path's own network work and slow it.
const INITIAL_DELAY_MS = 90_000;

const checkAll = async (host: EngineHost): Promise<void> => {
    const channels = await readEngineChannels(host.workspace.root);
    for (const descriptor of ENGINE_DESCRIPTORS) {
        const channel = channels[descriptor.id] ?? DEFAULT_CHANNEL;
        if (channel.kind === "image") {
            continue;
        }
        try {
            const applied = await convergeEngine(host, descriptor.id, installEngine);
            if (applied !== undefined) {
                host.logger.info({ engine: descriptor.id, version: applied.version }, "engine updated by the daily check");
            }
        } catch (error) {
            // One engine's failure does not stop the sweep; the rest still get checked.
            host.logger.warn({ err: error, engine: descriptor.id }, "engine check failed");
        }
    }
    lastCheckedAt = new Date().toISOString();
};

// One pass shortly after boot, then daily, unref'd and best-effort. The check runs only on the container's owning
// daemon, avoiding a two-daemon download race; the boot log runs on both, since each process answers for its own
// version.
export const startEngineWatch = (host: EngineHost, role: BootRole): { stop: () => void } => {
    void refreshClaudeSdk()
        .then((status) => host.logger.info({ ...status }, "claude engine"))
        .catch(() => undefined);
    if (!role.container) {
        return { stop: () => undefined };
    }
    const initial = setTimeout(() => void checkAll(host).catch(() => undefined), INITIAL_DELAY_MS);
    initial.unref?.();
    const timer = setInterval(() => void checkAll(host).catch(() => undefined), CHECK_INTERVAL_MS);
    timer.unref?.();
    return {
        stop: () => {
            clearTimeout(initial);
            clearInterval(timer);
        },
    };
};
