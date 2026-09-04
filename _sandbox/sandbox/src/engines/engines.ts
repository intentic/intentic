import type { EngineChannel, EngineId, EngineRow, EnginesView } from "@intentic/sandbox-contract";
import { ENGINE_IDS, isNewer } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { opt } from "../agent/opt.js";
import type { BootRole } from "../agent/provider-module.js";
import { refreshClaudeSdk } from "../claude/claude-sdk.js";
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

/* THE ENGINE LIFECYCLE, the five verbs the card and the daily check share.
 *
 *   view      , what each engine is running, what its channel would move it to, and what the ways out are.
 *   converge  , install what the channel asks for, if that is not already what is running. The daily check IS
 *               this, run over every engine; nothing else auto-installs.
 *   update    , converge one engine now, or install a version the owner named outright — the second is how a
 *               sandbox gets past an upstream floor the blessed list has not caught up with.
 *   revert    , go back to the version kept behind the current one, or to the image's copy when there is none.
 *   channel   , write the standing answer, and act on it at once when that answer is "the image".
 *
 * WHAT AUTO-INSTALLS AND WHAT ASKS is the line this file draws. A channel is an instruction: `blessed` means
 * take what this project has tested, `latest` means take upstream's newest, `pinned` means take exactly this.
 * Converge honours all three without a click, because that is what setting them said to do. What never happens
 * unattended is a version OUTSIDE the channel — the Update-anyway path takes an explicit version from a person
 * who has read why. */

export interface EngineHost {
    readonly workspace: { readonly root: string };
    readonly logger: Logger;
}

/* The install is a parameter on every verb that performs one, defaulting to the store's. The seam is what lets
 * a suite drive the DECISIONS here — converge when the channel has moved, do nothing when it has not, resolve a
 * floor to a version — without a real 300 MB download per case, and without the test being unable to tell "it
 * decided not to install" from "it installed something quickly". */
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
        // An offer is only an offer when it differs from what is running: a channel pointing at the version
        // already in use is the steady state, not a pending action.
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
    // One list read for the whole view: five rows asking independently would be five conditional requests.
    await blessedList();
    const engines = await Promise.all(ENGINE_IDS.map((id) => rowOf(host.workspace.root, id)));
    return {
        engines,
        listSource: blessedListSource(),
        ...opt("listReadAt", blessedListReadAt()),
        ...opt("checkedAt", lastCheckedAt),
    };
};

// When the daily check last ran, in-process: it is a fact about this daemon's uptime, not about the workspace,
// and a restart honestly has nothing to report until the first check runs.
let lastCheckedAt: string | undefined;

export interface EngineApplied {
    readonly ok: true;
    readonly version: string;
    readonly source: "image" | "store";
    readonly fromNextTurn: boolean;
}

/* Install what this engine's channel asks for, when that is not already what is running. Returns undefined
 * when there was nothing to do, which is the overwhelmingly common answer and the one the daily check gets. */
const convergeEngine = async (host: EngineHost, id: EngineId, install: EngineInstaller): Promise<EngineApplied | undefined> => {
    const channel = await engineChannel(host.workspace.root, id);
    if (channel.kind === "image") {
        // Not a no-op: an owner who switches to `image` while the store is active expects the next turn on the
        // baked copy, and a converge is where that lands if the channel write did not already do it.
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
    /* Compared against what is RUNNING, not against what the store has activated, and the difference is a
     * 300 MB download per sandbox: on a fresh box the blessed version IS the version the image bakes, and a
     * check that only looked at `active` (absent there) would dutifully download a copy of what is already
     * installed. Same rule the card's `offered` uses, so the button and the daily check agree. */
    const running = state.active ?? (await engineDescriptor(id).baked());
    if (target === undefined || target === running) {
        return undefined;
    }
    return apply(host, id, target, install);
};

/* Install one version and make it current.
 *
 * Three ways to say which: nothing at all means "whatever the channel asks for" (the row's Update button); a
 * VERSION is deliberate and may be one nobody has blessed; a FLOOR is the turn-failed path, where the caller
 * knows what the provider demanded and not which published version satisfies it — that is resolved here, to
 * the lowest one at or above it, so a browser never walks a registry to fill in a number. */
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
                // Nothing published satisfies it, or the registry could not be reached. Either way there is no
                // version to install, and saying so beats installing the newest thing available and hoping.
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

/* THE CHECK THAT THE FLOOR WAS ACTUALLY CLEARED, run after an install that was chosen to clear one.
 *
 * Selecting the version involved an assumption — that a package version maps onto the version the provider
 * states its floors in (engine-descriptors.ts) — and this is where that assumption stops being taken on faith:
 * the installed copy is asked what it calls itself. A copy that does not clear the floor is quarantined and
 * the engine falls back, because leaving it active would mean every turn on that model keeps failing with the
 * same error the owner just paid an install to fix, and the card would be claiming otherwise. */
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

/* Back to the version kept behind this one, or to the image's copy when the store holds nothing else. Both are
 * pointer moves: the previous version is still on disk (the store keeps exactly one back), which is what makes
 * this the safe thing to reach for when the network is the problem. */
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
    // "image" stands in for an engine the image bakes without a version this daemon can name (a binary on
    // PATH): the row still has to say what it went back to.
    return { ok: true, version: baked ?? "image", source: "image", fromNextTurn: true };
};

/* Write the standing answer, and converge when that answer can be honoured without a download: switching to
 * `image` takes effect at once (the copy is already there), while the other three may need one and are left to
 * the Update button or the daily check rather than blocking the click that set them. */
export const setChannel = async (host: EngineHost, id: EngineId, channel: EngineChannel): Promise<EngineChannel> => {
    const stored = await setEngineChannel(host.workspace.root, id, channel);
    if (stored.kind === "image") {
        await convergeEngine(host, id, installEngine);
    }
    return stored;
};

/* The version that would get a sandbox past an upstream floor it has just been refused by: the lowest one
 * published at or above the floor. Offered to the owner as a click, never taken automatically — the whole
 * point of the blessed default is that unblessed versions arrive with a person's consent. */
const versionForFloor = async (id: EngineId, floor: string): Promise<string | undefined> => {
    const entry = await blessedEntry(id);
    // If the list has already caught up, the blessed version IS the answer and no unblessed step is needed.
    if (entry !== undefined && (entry.blessed === floor || isNewer(entry.blessed, floor))) {
        return entry.blessed;
    }
    return lowestSatisfying(id, floor);
};

const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
// Delayed past boot for the reason the extension update watch is: the boot path has its own network work, and
// an engine check racing it would slow the thing an owner is actually waiting for.
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
            // One engine's bad day is not the sweep's: the rest still get their check, and the reason is on
            // the card (a quarantine) or in the log (a failed download).
            host.logger.warn({ err: error, engine: descriptor.id }, "engine check failed");
        }
    }
    lastCheckedAt = new Date().toISOString();
};

/* Boot wiring (main.ts): one pass shortly after boot, then daily, for the sandbox nobody opens. Unref'd, so it
 * never holds the event loop open, and best-effort by contract — a failed check leaves every engine exactly
 * where it was.
 *
 * The CHECK runs only on the daemon that owns the container: two daemons sharing a volume would otherwise race
 * two downloads for one pointer. The boot LOG runs on both, because "which Claude Code is this process on" is
 * a question about this process, and every turn refreshes that answer for itself regardless. */
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
