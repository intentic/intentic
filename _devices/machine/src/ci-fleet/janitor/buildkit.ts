import type { JanitorRun } from "./janitor-run.js";

/* THE INTENTIC-CACHE BUILDKIT STATE: the docker-container builder publish-images.sh creates keeps its cache in a docker
   volume, not under /ci-cache, so it is capped from inside the builder with `buildctl prune --keep-storage`, which
   takes only records no build is using. A builder that is stopped is started for the prune and stopped again after. */

const DOCKER_ASK_MS = 20_000;
const BUILDCTL_DU_MS = 300_000;
const BUILDCTL_PRUNE_MS = 1_800_000;

const UNITS = new Map([
    ["kB", 1e3],
    ["KB", 1e3],
    ["MB", 1e6],
    ["GB", 1e9],
    ["TB", 1e12],
]);

/** `buildctl du` prints decimal units ("99.36GB"); a bare number is bytes. */
export const humanToBytes = (text: string): number => {
    const match = /^([0-9.]+)(.*)$/u.exec(text.trim());
    return match === null ? 0 : Math.trunc(Number(match[1]) * (UNITS.get(match[2] ?? "") ?? 1));
};

// The `Total:` line of `buildctl du`, or undefined when it did not answer.
export const buildctlTotal = (stdout: string): string | undefined => /^Total:\s+(\S+)/mu.exec(stdout)?.[1];

const duOf = async (run: JanitorRun, container: string): Promise<string | undefined> => {
    const du = await run.context.sys.run("docker", ["exec", container, "buildctl", "du"], { timeoutMs: BUILDCTL_DU_MS });
    return du.status === 0 ? buildctlTotal(du.stdout) : undefined;
};

const containerIds = async (run: JanitorRun, all: boolean, container: string): Promise<string> =>
    (await run.context.sys.run("docker", ["ps", all ? "-aq" : "-q", "--filter", `name=^${container}$`], { timeoutMs: DOCKER_ASK_MS })).stdout.trim();

// The prune itself, on a builder that answers: what it freed, said with the sizes before and after.
const pruneBuilder = async (run: JanitorRun, container: string, before: string): Promise<number> => {
    const keep = run.config.buildkitKeepGb;
    const prune = await run.context.sys.run("docker", ["exec", container, "buildctl", "prune", "--keep-storage", String(keep * 1024)], { timeoutMs: BUILDCTL_PRUNE_MS });
    if (prune.status !== 0) {
        run.record.say("buildkit prune failed or timed out");
    }
    const after = await duOf(run, container);
    run.record.say(`buildkit ${container}: ${before} -> ${after ?? "unknown"} (cap ${keep} GB)`);
    return after === undefined ? 0 : Math.max(0, humanToBytes(before) - humanToBytes(after));
};

/** Caps the builder's state; answers the bytes docker freed. */
export const capBuildkit = async (run: JanitorRun): Promise<number> => {
    const { sys } = run.context;
    const container = run.config.buildkitContainer;
    if ((await sys.run("docker", ["version"], { timeoutMs: DOCKER_ASK_MS })).status !== 0) {
        run.record.say("docker not answering in this distro; buildkit left for the next pass");
        return 0;
    }
    if ((await containerIds(run, true, container)) === "") {
        return 0;
    }
    let started = false;
    if ((await containerIds(run, false, container)) === "" && !run.record.dryRun) {
        started = (await sys.run("docker", ["start", container], { timeoutMs: DOCKER_ASK_MS * 3 })).status === 0;
    }
    const before = await duOf(run, container);
    let freed = 0;
    if (!run.record.dryRun && before !== undefined) {
        freed = await pruneBuilder(run, container, before);
    } else {
        run.record.say(`buildkit ${container}: ${before ?? "unknown"} in use, cap ${run.config.buildkitKeepGb} GB`);
    }
    if (started) {
        await sys.run("docker", ["stop", container], { timeoutMs: DOCKER_ASK_MS * 3 });
    }
    return freed;
};
