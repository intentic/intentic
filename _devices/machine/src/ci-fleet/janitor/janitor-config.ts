import { z } from "zod";

// The janitor's settings in /etc/intentic-ci/fleet.json (`janitor`), each named and defaulted as fleet-janitor.sh's
// environment did (its `JANITOR_*` name beside each). The cache root and the state folder are the fleet's own
// (`cacheRoot`, `stateDir`: `JANITOR_CACHE_ROOT`, `JANITOR_STATE_DIR`).
export const JanitorConfigSchema = z.object({
    enabled: z.boolean().default(true),
    // Where the runner folders are; the janitor's `JANITOR_RUNNERS_GLOB`.
    runnersGlob: z.string().default("/home/*/actions-runner-*"),
    // Per-runner pnpm store (actions-work-N/.pnpm-store): removed above this size. `JANITOR_WORKSPACE_STORE_CAP_GB`.
    workspaceStoreCapGb: z.number().nonnegative().default(6),
    // A runner's checkout (<work>/<repo>/<repo>/.git): repacked once it holds more than this many packs. actions/checkout
    // sets gc.auto=0 and every shallow fetch adds a pack, so nothing else ever repacks: omen's worker checkouts held
    // 520-540 packs and 3-7 GB of .git each on 2026-11-17, and 570 MB each after `git gc --prune=now` (about 20 s).
    // `JANITOR_GIT_PACKS_MAX`.
    gitPacksMax: z.number().int().nonnegative().default(50),
    // /ci-cache/*-target: removed above this size, or when nothing in it was written for targetStaleDays.
    // `JANITOR_TARGET_CAP_GB`, `JANITOR_TARGET_STALE_DAYS`.
    targetCapGb: z.number().nonnegative().default(20),
    targetStaleDays: z.number().int().nonnegative().default(14),
    // All /ci-cache/*-target dirs together: above this, the least recently built go first. Eleven dirs under a 20 GB cap
    // each could otherwise reach 220 GB. `JANITOR_TARGETS_TOTAL_CAP_GB`.
    targetsTotalCapGb: z.number().nonnegative().default(60),
    // Every other /ci-cache entry: its own cap in cacheCaps, or this one. `JANITOR_CACHE_CAP_GB`.
    cacheCapGb: z.number().nonnegative().default(15),
    // `JANITOR_ONBOARDING_DOCKER_CAP_GB`, `JANITOR_PNPM_STORE_CAP_GB`, `JANITOR_CARGO_CAP_GB`.
    cacheCaps: z.record(z.string(), z.number().nonnegative()).default({ "onboarding-docker": 30, "pnpm-store": 20, cargo: 20 }),
    // /ci-cache/turbo: files older than a few days go first, and younger ones only if that was not enough.
    // `JANITOR_TURBO_CAP_GB`.
    turboCapGb: z.number().nonnegative().default(10),
    // A runner's _diag (its own logs, one Worker_*.log per job, and pages/ and blocks/ of step logs it failed to
    // upload): files older than this. omen's busiest runner held 10 GB there on 2026-11-12, all but 0.2 GB of it older
    // than 14 days. `JANITOR_DIAG_DAYS`.
    diagDays: z.number().int().nonnegative().default(14),
    // A runner's self-update leaves the download in <work>/_update; one older than this is not an update still running.
    // `JANITOR_UPDATE_STALE_DAYS`.
    updateStaleDays: z.number().int().nonnegative().default(1),
    // The docker-container builder publish-images.sh creates. Its state is a docker volume, not a /ci-cache path.
    // `JANITOR_BUILDKIT_CONTAINER`, `JANITOR_BUILDKIT_KEEP_GB`.
    buildkitContainer: z.string().default("buildx_buildkit_intentic-cache0"),
    buildkitKeepGb: z.number().nonnegative().default(25),
    // A pass that frees at least this much, in the distro's disk and docker's together, leaves
    // <state>/compact-requested for the Windows-side maintenance task (wsl-maintenance.ps1, which omen runs). On a sparse
    // VHDX the space is back on Windows as soon as it is trimmed, and the task only drops the request; on one that is
    // not sparse, freed blocks come back only with a compaction, which needs WSL shut down. `JANITOR_COMPACT_REQUEST_GB`.
    compactRequestGb: z.number().nonnegative().default(40),
});
export type JanitorConfig = z.infer<typeof JanitorConfigSchema>;
