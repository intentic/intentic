import { formatBytes, formatElapsed, timeAgo } from "@intentic/extension-ui/format";
import type { CiRepo, PipelineStatus } from "@intentic/sandbox-contract/schemas/ci";
import { t } from "../i18n";
import type { CiFleet, CiFleetPass, CiFleetService, CiRunner, CiRunnerOp, CiSlots, Device } from "./fleetTypes";

// The Runners section's reading of the daemon's answers (schemas/ci-fleet.ts): which computers get a group, what each
// runner row says, and which presses it offers. Kept out of the components so the wording and the gating are tested
// without a browser, as statusVisual.ts and runSide.ts are.

/** A connected computer whose agent can list its CI runners, addressed by its connection's id. */
export interface FleetDevice {
    readonly id: string;
    readonly label: string;
}

/** One computer's answer: its fleet, or the daemon's sentence for why it could not read one. */
export interface FleetRead {
    readonly device: FleetDevice;
    readonly fleet?: CiFleet | undefined;
    readonly error?: string | undefined;
}

// The feature a machine's agent advertises once it can list its runners (`DEVICE_FEATURE_CI_RUNNERS` in the contract's
// schemas/hosts.ts, a subpath outside the extension wire, so named here by its word).
const CI_RUNNERS_FEATURE = `ci-runners`;

// Only a live connection can be asked, and only an agent that says it can list runners (a Linux one: they are systemd
// units). A sync-only row has no connection to relay through.
export const fleetDevices = (devices: readonly Device[]): FleetDevice[] =>
    devices.flatMap((device) =>
        device.hostId !== undefined && device.online !== false && (device.facts?.features ?? []).includes(CI_RUNNERS_FEATURE)
            ? [{ id: device.hostId, label: device.label }]
            : [],
    );

/** The repositories a new runner can serve: the workspace's, whose CI remote is GitHub. */
export const githubRepos = (repos: readonly CiRepo[]): CiRepo[] => repos.filter((repo) => repo.host === `github`);

// A computer earns a group when it has runners, when its fleet service is there to add one, or when the read failed,
// which says why in the daemon's words. A Linux computer with neither runners nor the service has nothing to show.
const worthAGroup = (read: FleetRead): boolean =>
    read.fleet === undefined ? read.error !== undefined : read.fleet.runners.length > 0 || read.fleet.service.installed;

export const shownReads = (reads: readonly FleetRead[]): FleetRead[] => reads.filter(worthAGroup);

export interface ServiceLine {
    readonly tone: `success` | `warning` | `neutral`;
    readonly text: string;
    readonly problem?: string | undefined;
}

export const serviceLine = (service: CiFleetService): ServiceLine => {
    if (service.running) {
        return {
            tone: `success`,
            text: service.version === undefined ? t(`runners.service.running`) : t(`runners.service.runningVersion`, { version: service.version }),
        };
    }
    if (service.installed) {
        return { tone: `warning`, text: t(`runners.service.notAnswering`), problem: service.problem };
    }
    return { tone: `neutral`, text: t(`runners.service.notInstalled`) };
};

// The sandboxes' hold is what CI cannot have; the gate band below `reserved` stays CI's (test-memory-pool.mjs).
export const poolLine = (slots: CiSlots): string =>
    t(`runners.pool`, { usable: Math.max(0, slots.total - slots.heldForSandboxes), total: slots.total, held: slots.heldForSandboxes });

// A runner's glyph, borrowed from the run statuses so a busy runner spins as a running run does and a down one reads
// as a run that stopped. A unit systemd lost reads as failed: it will not come back by itself.
export const runnerStatus = (runner: CiRunner): PipelineStatus => {
    if (runner.busy) {
        return `running`;
    }
    switch (runner.state) {
        case `active`:
            return `success`;
        case `activating`:
        case `deactivating`:
        case `reloading`:
            return `queued`;
        case `failed`:
        case `not-installed`:
            return `failed`;
        case `inactive`:
            return `canceled`;
        default:
            return `skipped`;
    }
};

const heldWords = (held: NonNullable<CiRunner[`held`]>): string => t(`runners.held.${held}`);

const busyWords = (runner: CiRunner, now: number): string => {
    const job = runner.job ?? t(`runners.doing.aJob`);
    if (runner.busySince === undefined) {
        return t(`runners.doing.running`, { job });
    }
    const since = Date.parse(runner.busySince);
    return Number.isNaN(since) ? t(`runners.doing.running`, { job }) : t(`runners.doing.runningFor`, { job, elapsed: formatElapsed((now - since) / 1000) });
};

/** What the runner is doing, one line: its job, a drain waiting on it, why it is held down, or idle. */
export const runnerDoing = (runner: CiRunner, now: number): string => {
    if (runner.state === `not-installed`) {
        return t(`runners.doing.notInstalled`);
    }
    if (runner.draining) {
        return runner.busy ? `${busyWords(runner, now)} · ${t(`runners.doing.draining`)}` : t(`runners.doing.draining`);
    }
    if (runner.busy) {
        return busyWords(runner, now);
    }
    if (runner.held !== undefined) {
        return heldWords(runner.held);
    }
    if (runner.state === `failed`) {
        return t(`runners.doing.failed`);
    }
    if (runner.state === `inactive`) {
        return t(`runners.doing.stopped`);
    }
    return runner.state === `active` ? t(`runners.doing.idle`) : t(`runners.doing.state`, { state: runner.state });
};

/** One press a row offers: shown, and if refused, why in words. */
export interface RunnerPress {
    readonly enabled: boolean;
    readonly reason?: string | undefined;
}

export interface RunnerPresses {
    readonly start?: RunnerPress;
    readonly drain?: RunnerPress;
    readonly restart?: RunnerPress;
    readonly stop?: RunnerPress;
    readonly remove: RunnerPress;
}

const ON: RunnerPress = { enabled: true };

// What the fleet service accepts for a runner as it stands (schemas/ci-fleet.ts `CiRunnerOp`). Ops need the service; a
// unit systemd lost takes none of them, only a removal and a fresh registration. Stop and remove refuse a runner
// mid-job, so the row says to drain it rather than leaving the press to fail.
export const runnerPresses = (runner: CiRunner, service: CiFleetService): RunnerPresses => {
    const busyRefusal: RunnerPress = runner.busy ? { enabled: false, reason: t(`runners.action.drainInstead`) } : ON;
    if (!service.running) {
        return { remove: { enabled: false, reason: t(`runners.action.needsService`) } };
    }
    if (runner.state === `not-installed`) {
        return { remove: ON };
    }
    const up = runner.state === `active` || runner.state === `activating` || runner.state === `reloading`;
    const presses: RunnerPresses = { remove: busyRefusal };
    if (!up || runner.held !== undefined) {
        return { ...presses, start: ON };
    }
    return {
        ...presses,
        drain: runner.draining ? { enabled: false, reason: t(`runners.doing.draining`) } : ON,
        restart: runner.draining ? { enabled: false, reason: t(`runners.doing.draining`) } : ON,
        stop: busyRefusal,
    };
};

/** The op presses in the order a row draws them. */
export const RUNNER_OPS: readonly CiRunnerOp[] = [`start`, `drain`, `restart`, `stop`];

// The light lane (docs/ops/ci-runner.md): `<host>-light-<n>` takes only a pipeline's first two jobs, so it carries
// that lane's label alone; every other instance is a full desktop worker.
const LIGHT_NAME = /-light-\d+$/;
const LIGHT_LABELS = `intentic-light`;
const WORKER_LABELS = `intentic,desktop`;
export const defaultLabels = (name: string): string => (LIGHT_NAME.test(name) ? LIGHT_LABELS : WORKER_LABELS);

export const parseLabels = (text: string): string[] =>
    text
        .split(`,`)
        .map((label) => label.trim())
        .filter((label) => label !== ``);

const WORKER_NAME = /^(.+)-worker-(\d+)$/;

// The host part the computer's runners already use (`z440-worker-3` → `z440`), else the computer's own name made into
// a runner name; then one past the highest worker number on it.
export const suggestRunnerName = (device: FleetDevice, runners: readonly CiRunner[]): string => {
    const workers = runners.flatMap((runner) => {
        const match = WORKER_NAME.exec(runner.name);
        return match?.[1] === undefined || match[2] === undefined ? [] : [{ host: match[1], n: Number(match[2]) }];
    });
    const host =
        workers[0]?.host ??
        (device.label
            .toLowerCase()
            .replaceAll(/[^a-z0-9._-]+/g, `-`)
            .replaceAll(/^-+|-+$/g, ``) ||
            `runner`);
    const next = workers.reduce((top, worker) => Math.max(top, worker.n), 0) + 1;
    return `${host}-worker-${next}`;
};

export type PassKind = `janitor` | `keeper` | `prune`;

export interface PassView {
    readonly kind: PassKind;
    readonly title: string;
    readonly summary: string;
    readonly lines: readonly string[];
}

const passSummary = (pass: CiFleetPass, now: number): string => {
    const at = Date.parse(pass.at);
    const when = Number.isNaN(at) ? pass.at : timeAgo(at, { now });
    const parts = [when];
    if (pass.freedBytes > 0) {
        parts.push(t(`runners.pass.freed`, { bytes: formatBytes(pass.freedBytes) }));
    }
    if (pass.dryRun) {
        parts.push(t(`runners.pass.dryRun`));
    }
    return parts.join(` · `);
};

/** The fleet service's last passes, the ones it has run, for the collapsed block under a computer's runners. */
export const passViews = (fleet: CiFleet, now: number): PassView[] =>
    ([`janitor`, `keeper`, `prune`] as const).flatMap((kind) => {
        const pass = fleet[kind];
        return pass === undefined ? [] : [{ kind, title: t(`runners.pass.${kind}`), summary: passSummary(pass, now), lines: pass.lines }];
    });
