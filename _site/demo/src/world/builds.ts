import type { HostedBuildState, HostedBuildStatus } from "@intentic/api-contract";
import { placeHosted, rowOf } from "./sandboxRegistry";

// THE ENVIRONMENT BUILDS OF THE MACHINES OF OURS: a hosted sandbox has no host to run `ic sandbox rebuild` on, so the
// platform builds the approved overlay into its image and restarts it onto it. Here the builder's log is written a line
// at a time at a pace the Environment card's five-second poll sees move, and a build that finishes swaps the machine:
// it reads as starting, then awake on the new image, with the image before it kept for a rollback.

const LINE_MS = 2_200;
const RESTART_MS = 3_000;

interface Builds {
    build: HostedBuildState | null;
    applied: string | null;
    // The hash the machine booted before its last image change: what a rollback goes back to.
    before: string | null;
}

const bySandbox = new Map<string, Builds>();

const entryOf = (sandboxId: string): Builds => {
    const found = bySandbox.get(sandboxId);
    if (found !== undefined) {
        return found;
    }
    const fresh: Builds = { build: null, applied: null, before: null };
    bySandbox.set(sandboxId, fresh);
    return fresh;
};

/** sandbox.hostedBuildStatus: the build in flight or last finished, and the hash the machine last booted. */
export const buildStatus = (sandboxId: string): HostedBuildStatus => {
    const { build, applied } = entryOf(sandboxId);
    return { build: build === null ? null : { ...build }, applied };
};

export const building = (sandboxId: string): boolean => entryOf(sandboxId).build?.state === `building`;

// The builder's own words, as a Docker build of an overlay prints them; the overlay's RUN lines are its steps.
const logLines = (content: string, hash: string): string[] => {
    const runs = content
        .split(`\n`)
        .map((line) => line.trim())
        .filter((line) => /^(RUN|COPY|ENV)\b/.test(line));
    const steps = runs.length === 0 ? [`RUN true`] : runs;
    return [
        `#1 [internal] load build definition from Dockerfile.overlay`,
        `#2 [base] FROM ghcr.io/intentic/sandbox:stable`,
        ...steps.map((step, index) => `#${index + 3} [overlay ${index + 1}/${steps.length}] ${step}`),
        `#${steps.length + 3} exporting to image`,
        `#${steps.length + 3} naming to registry.fly.io/intentic-sandbox:overlay-${hash.slice(0, 12)} done`,
    ];
};

// The machine restarts onto the image just built: the row reads starting, then awake with a rollback on offer.
const swapOnto = (sandboxId: string, entry: Builds, hash: string): void => {
    const hosted = rowOf(sandboxId)?.hosted ?? null;
    entry.before = entry.applied ?? `0`.repeat(64);
    if (hosted !== null) {
        placeHosted(sandboxId, { ...hosted, state: `starting` });
    }
    setTimeout(() => {
        entry.applied = hash;
        const now = rowOf(sandboxId)?.hosted ?? null;
        if (now !== null) {
            placeHosted(sandboxId, { ...now, state: `awake`, canRollBack: true });
        }
    }, RESTART_MS);
};

/** sandbox.hostedRebuild: the build starts now and its log grows a line at a time until it is built and swapped in. */
export const startBuild = (sandboxId: string, hash: string, content: string): HostedBuildState => {
    const entry = entryOf(sandboxId);
    const lines = logLines(content, hash);
    const started: HostedBuildState = { state: `building`, hash, startedAt: new Date().toISOString(), log: `` };
    entry.build = started;
    const next = (index: number): void => {
        // A newer build replaced this one: its own timers write the log from here on.
        if (entry.build?.startedAt !== started.startedAt || entry.build.hash !== hash) {
            return;
        }
        const log = lines.slice(0, index + 1).join(`\n`);
        if (index + 1 < lines.length) {
            entry.build = { ...started, log };
            setTimeout(() => next(index + 1), LINE_MS);
            return;
        }
        entry.build = { ...started, state: `built`, log, finishedAt: new Date().toISOString() };
        swapOnto(sandboxId, entry, hash);
    };
    setTimeout(() => next(0), LINE_MS);
    return { ...started };
};

/**
 * sandbox.hostedRollback: back onto the image before the last change, through a restart; false when the platform kept
 * none, which is the CONFLICT the real one answers.
 */
export const rollBack = (sandboxId: string): boolean => {
    const entry = entryOf(sandboxId);
    const hosted = rowOf(sandboxId)?.hosted ?? null;
    if (hosted === null || hosted.canRollBack !== true) {
        return false;
    }
    placeHosted(sandboxId, { ...hosted, state: `starting`, canRollBack: false });
    setTimeout(() => {
        entry.applied = entry.before;
        entry.before = null;
        const now = rowOf(sandboxId)?.hosted ?? null;
        if (now !== null) {
            placeHosted(sandboxId, { ...now, state: `awake`, canRollBack: false });
        }
    }, RESTART_MS);
    return true;
};

/** The platform's own check: only bytes matching the hash the owner reviewed are built. */
export const hashOf = async (content: string): Promise<string> =>
    Array.from(new Uint8Array(await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(content))), (byte) => byte.toString(16).padStart(2, `0`)).join(``);
