import type { EngineChannel, EngineId, EngineRow, EnginesView, EngineWriteResult } from "@intentic/sandbox-contract/schemas/engines";
import { refuse } from "@intentic/contract-serve";
import { pause, pushDomains } from "./machineKit";

// The agent engines this sandbox runs, as the Environment card reads and drives them (the daemon's engines/engines.ts):
// what the image bakes, what the store installed over it, the channel's offer, and the one version kept back. Update,
// revert and a channel change all act on this record, so the card's next read and every other tab (the `engines` push)
// see the version the press moved to.

const MB = 1024 * 1024;
// How long an install takes here: long enough to watch the row say "Updating", short enough to wait for.
const INSTALL_MS = 4_200;
// A revert is a pointer move in the store, nearly instant on a real sandbox too.
const REVERT_MS = 900;

interface EngineRecord {
    readonly id: EngineId;
    readonly label: string;
    // What the image bakes, the floor everything falls back to; undefined for an engine the image carries no copy of.
    readonly baked: string | undefined;
    // The store's active version and the one kept back for a revert.
    active: string | undefined;
    previous: string | undefined;
    channel: EngineChannel;
    // What the blessed list names, and upstream's newest.
    readonly blessed: string | undefined;
    readonly latest: string | undefined;
    readonly quarantined: EngineRow[`quarantined`];
    installing: boolean;
    readonly diskMb: number;
}

const HOUR = 3_600_000;
const STARTED = Date.now();

// One of each story the card tells: Claude with a blessed update waiting, Codex on `latest` ahead of the blessed list,
// Cursor pinned, OpenCode on the image's copy, Grok never installed, and Kimi with a refused publish in quarantine.
const engines: EngineRecord[] = [
    { id: `claude`, label: `Claude Code`, baked: `2.1.38`, active: `2.1.44`, previous: `2.1.41`, channel: { kind: `blessed` }, blessed: `2.1.47`, latest: `2.1.49`, quarantined: [], installing: false, diskMb: 412 },
    { id: `codex`, label: `Codex`, baked: `0.95.0`, active: `0.98.1`, previous: `0.97.0`, channel: { kind: `latest` }, blessed: `0.97.0`, latest: `0.99.0`, quarantined: [], installing: false, diskMb: 268 },
    { id: `cursor`, label: `Cursor`, baked: `1.4.2`, active: `1.5.0`, previous: `1.4.2`, channel: { kind: `pinned`, version: `1.5.0` }, blessed: `1.5.3`, latest: `1.6.0`, quarantined: [], installing: false, diskMb: 96 },
    { id: `devin`, label: `Devin`, baked: `0.8.4`, active: undefined, previous: undefined, channel: { kind: `blessed` }, blessed: `0.8.4`, latest: `0.9.1`, quarantined: [], installing: false, diskMb: 0 },
    { id: `muse`, label: `Muse Code`, baked: `0.3.2`, active: undefined, previous: undefined, channel: { kind: `blessed` }, blessed: `0.3.2`, latest: `0.3.2`, quarantined: [], installing: false, diskMb: 0 },
    { id: `opencode`, label: `OpenCode`, baked: `1.2.10`, active: undefined, previous: `1.3.0`, channel: { kind: `image` }, blessed: `1.3.1`, latest: `1.3.4`, quarantined: [], installing: false, diskMb: 58 },
    { id: `translator`, label: `Subscription translator`, baked: `6.6.12`, active: undefined, previous: undefined, channel: { kind: `blessed` }, blessed: `6.6.12`, latest: `6.6.19`, quarantined: [], installing: false, diskMb: 0 },
    {
        id: `kimi`,
        label: `Kimi Code CLI`,
        baked: `0.41.0`,
        active: `0.42.3`,
        previous: `0.41.0`,
        channel: { kind: `latest` },
        blessed: `0.42.3`,
        latest: `0.43.0`,
        // Upstream's newest would not start here; the store went back and keeps it out of `latest` until a newer one.
        quarantined: [{ version: `0.43.0`, reason: `It exited at launch: "kimi: unknown flag --output-format".`, at: new Date(STARTED - 9 * HOUR).toISOString() }],
        installing: false,
        diskMb: 74,
    },
    { id: `grok-build`, label: `Grok Build`, baked: undefined, active: undefined, previous: undefined, channel: { kind: `blessed` }, blessed: `0.6.0`, latest: `0.6.2`, quarantined: [], installing: false, diskMb: 0 },
];

const running = (engine: EngineRecord): string | undefined => (engine.channel.kind === `image` ? engine.baked : (engine.active ?? engine.baked));

// What the channel asks for: blessed, latest (skipping a quarantined publish), the pinned version, or nothing on image.
const target = (engine: EngineRecord): string | undefined => {
    switch (engine.channel.kind) {
        case `blessed`:
            return engine.blessed;
        case `latest`:
            return engine.quarantined.some((refused) => refused.version === engine.latest) ? engine.blessed : engine.latest;
        case `pinned`:
            return engine.channel.version;
        case `image`:
            return undefined;
    }
};

const rowOf = (engine: EngineRecord): EngineRow => {
    const now = running(engine);
    const offer = target(engine);
    // Absent fields go out as undefined, which the wire drops: the shape the daemon's own `opt` builds.
    return {
        id: engine.id,
        label: engine.label,
        running: { version: now, source: engine.channel.kind !== `image` && engine.active !== undefined ? `store` : `image` },
        baked: engine.baked,
        channel: engine.channel,
        offered: offer === undefined || offer === now ? undefined : { version: offer, blessed: offer === engine.blessed },
        blessed: engine.blessed,
        previous: engine.previous,
        quarantined: engine.quarantined,
        diskBytes: engine.diskMb * MB,
        installing: engine.installing || undefined,
    };
};

export const enginesView = (): EnginesView => ({
    engines: engines.map(rowOf),
    checkedAt: new Date(STARTED - 3 * HOUR).toISOString(),
    listSource: `https://intentic.dev/engines/blessed.json`,
    listReadAt: new Date(STARTED - 3 * HOUR).toISOString(),
});

const engineOf = (id: EngineId): EngineRecord => engines.find((engine) => engine.id === id) ?? refuse(`unknown engine`, 404);

const written = (engine: EngineRecord | undefined): EngineWriteResult => {
    const version = engine === undefined ? undefined : running(engine);
    return {
        applied:
            engine === undefined || version === undefined
                ? null
                : // Cursor's SDK is loaded into the daemon's own process, so a turn already running keeps its module.
                  { ok: true, version, source: rowOf(engine).running.source, fromNextTurn: engine.id === `cursor` },
        engines: enginesView(),
    };
};

/** Installs and activates `version`, or the channel's offer; null `applied` when there is nothing to do, as the daemon. */
export const updateEngine = async (id: EngineId, version: string | undefined, floor: string | undefined): Promise<EngineWriteResult> => {
    const engine = engineOf(id);
    const wanted = version ?? (floor !== undefined && engine.latest !== undefined ? engine.latest : target(engine));
    if (wanted === undefined || wanted === running(engine) || engine.installing) {
        return written(undefined);
    }
    engine.installing = true;
    pushDomains(`engines`);
    try {
        await pause(INSTALL_MS);
        engine.previous = running(engine);
        engine.active = wanted;
        // An explicit version is "update anyway": it stays put rather than being moved back by the channel's next check.
        if (version !== undefined && engine.channel.kind !== `latest`) {
            engine.channel = { kind: `pinned`, version };
        }
        if (engine.channel.kind === `image`) {
            engine.channel = { kind: `blessed` };
        }
        return written(engine);
    } finally {
        engine.installing = false;
        pushDomains(`engines`);
    }
};

/** Goes back to the version kept one step back; refused when nothing is kept, as the daemon does. */
export const revertEngine = async (id: EngineId): Promise<EngineWriteResult> => {
    const engine = engineOf(id);
    const back = engine.previous ?? refuse(`there is no earlier version of ${engine.label} kept to go back to`, 409);
    await pause(REVERT_MS);
    engine.previous = running(engine);
    engine.active = back === engine.baked ? undefined : back;
    // Going back is a decision to stay there: the channel holds it rather than offering the same update straight away.
    engine.channel = back === engine.baked ? { kind: `image` } : { kind: `pinned`, version: back };
    pushDomains(`engines`);
    return written(engine);
};

/** The owner's standing answer for one engine; the daemon converges on it at once, which here is the next read. */
export const setEngineChannel = async (id: EngineId, kind: EngineChannel[`kind`], version: string | undefined): Promise<EngineWriteResult> => {
    const engine = engineOf(id);
    if (kind === `pinned` && version === undefined) {
        return refuse(`a pinned channel names its version`, 400);
    }
    engine.channel = kind === `pinned` ? { kind, version } : { kind };
    pushDomains(`engines`);
    // Image is a switch back to the baked copy, which the daemon applies at once; any other channel offers its version.
    return kind === `image` ? written(engine) : written(undefined);
};
