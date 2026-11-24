import { z } from "zod";

// The host prune's settings in /etc/intentic-ci/fleet.json (`prune`), each named and defaulted as linux-host-prune.sh's
// environment did (its `PRUNE_*` name beside each). Off by default: a computer whose Docker is shared with Windows
// (omen's Docker Desktop) is pruned by wsl-maintenance.ps1, and `ci-fleet install --prune` turns it on where Docker is
// the host's own (z440). The state folder is the fleet's (`stateDir`, `PRUNE_STATE_DIR`) and the runner folders are the
// janitor's glob (`janitor.runnersGlob`, `PRUNE_RUNNERS_GLOB`, which had the same default).
export const PruneConfigSchema = z.object({
    enabled: z.boolean().default(false),
    // Where setup-linux-runner.sh keeps the runner tarballs it downloads. `PRUNE_RUNNER_CACHE`.
    runnerCache: z.string().default("/var/cache/intentic-ci"),
    // Unused images older than this go on every full pass; under pressure every unused image goes. `PRUNE_IMAGE_AGE`.
    imageAge: z.string().default("48h"),
    // The default builder's cache above this is pruned, least recently used first (dockerd's own gc does the same, in
    // the background, from /etc/docker/daemon.json). `PRUNE_BUILD_CACHE_MAX`.
    buildCacheMax: z.string().default("40GB"),
    // Runner _diag logs (one Worker_*.log per job) older than this. `PRUNE_DIAG_DAYS`.
    diagDays: z.number().int().nonnegative().default(14),
    // A full pass waits for a moment with no job, but a host busy around the clock still gets one this often.
    // `PRUNE_FORCE_AFTER_HOURS`.
    forceAfterHours: z.number().nonnegative().default(24),
    // At this much of / used, a full pass runs now and takes every unused image and all build cache.
    // `PRUNE_PRESSURE_PERCENT`.
    pressurePercent: z.number().int().min(1).max(100).default(80),
});
export type PruneConfig = z.infer<typeof PruneConfigSchema>;
