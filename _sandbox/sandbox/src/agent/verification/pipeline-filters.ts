import { agentCommand, commandSegments, shellScriptOf } from "../providers/agent-installs.js";

// Which stages of a command's last pipeline only filter what an earlier stage printed. grep and its kin exit 1 when
// nothing matched, which says the filter found nothing, not that the check before it failed. 2026-11-17, the
// shinobi-society audit: a passing `cargo test 2>&1 | grep -E "FAILED|panicked" | head` read as a failed check,
// grep's 1 taken for the earliest stage that failed. The same set lives in output-cleaners' agent-output-filter.mjs,
// which writes the footer this side reads.
const FILTERS = new Set(["grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack"]);

// How deep a lone shell wrapper is read for its pipeline.
const WRAPPER_DEPTH = 4;

interface PipelineStages {
    // How many stages the last pipeline has; a status list of another length is not this pipeline's.
    readonly stages: number;
    // The stages past the first that are filters, by position.
    readonly filters: ReadonlySet<number>;
}

const lastPipelineOf = (command: string, depth = 0): PipelineStages => {
    const segments = commandSegments(agentCommand(command));
    const script = segments.length === 1 && depth < WRAPPER_DEPTH ? shellScriptOf(segments[0]?.words ?? []) : undefined;
    if (script !== undefined) {
        return lastPipelineOf(script, depth + 1);
    }
    let start = segments.length - 1;
    while (start > 0 && segments[start - 1]?.next === "|") {
        start -= 1;
    }
    const stages = segments.slice(Math.max(0, start));
    const filters = stages.flatMap((stage, index) => (index > 0 && FILTERS.has(stage.words[0]?.split("/").at(-1) ?? "") ? [index] : []));
    return { stages: stages.length, filters: new Set(filters) };
};

// A stage's status that says nothing went wrong: 0, 141 (cut off by a reader that closed early, `| head`), or a
// filter's 1 (nothing matched).
const quietStatus = (status: number, index: number, pipeline: PipelineStages | undefined): boolean =>
    status === 0 || status === 141 || (status === 1 && pipeline?.filters.has(index) === true);

// A pipeline's exit code given alone, with no per-stage statuses (Codex, ACP runtimes and Devin report one number; the
// tmux footer has none when its status file was not written). No agent shell sets pipefail, so that number is the last
// stage's: a 1 from a last stage that is a filter is the filter matching nothing, read as 0 like the statuses case.
// 2026-11-17, after the shinobi-society audit: these runtimes still read `cargo test | grep FAILED` with no match as
// a failed check. A command that turns pipefail on keeps its 1, which could then be any stage's.
export const bareExit = (exit: number, command: string | undefined): number => {
    if (exit !== 1 || command === undefined || /\bpipefail\b/.test(command)) {
        return exit;
    }
    const read = lastPipelineOf(command);
    return read.filters.has(read.stages - 1) ? 0 : exit;
};

// How a pipeline exited, from its per-stage statuses: the earliest stage before the last that failed (the check; what
// follows only filtered its output), else the last stage's, read as 0 when it is a filter that matched nothing. The
// command, when given, says which stages are filters; without it every non-zero status counts. No statuses at all is
// `bareExit`.
export const pipelineExit = (statuses: readonly number[], exit: number, command: string | undefined): number => {
    if (statuses.length === 0) {
        return bareExit(exit, command);
    }
    const read = command === undefined ? undefined : lastPipelineOf(command);
    const pipeline = read?.stages === statuses.length ? read : undefined;
    const failed = statuses.slice(0, -1).findIndex((status, index) => !quietStatus(status, index, pipeline));
    if (failed !== -1) {
        return statuses[failed] ?? exit;
    }
    const last = statuses.length - 1;
    return exit === 1 && statuses[last] === 1 && pipeline?.filters.has(last) === true ? 0 : exit;
};
