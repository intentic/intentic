import type { SideViewInput, SideViewLabel } from "@intentic/extension-api";
import type { CiRepo, CiRunsResponse, PipelineRun } from "@intentic/sandbox-contract";
import { STATUS_TONE } from "./statusVisual";
import { t } from "./i18n.js";

// One CI run in the editor's side panel: which run a tab or a link names, what its tab says, and where its page is.
// Pure, so the tab, the claim and the body all read one rule.

// The side view's id, as the manifest declares it.
export const RUN_SIDE_VIEW = `run`;

export interface RunRef {
    readonly repo: string;
    readonly runId: number;
}

// A tab's input read back, since a stored tab is only as good as the payload it came back from.
export const runRefOf = (input: SideViewInput): RunRef | undefined => {
    const repo = String(input[`repo`] ?? ``);
    const runId = Number(input[`runId`]);
    return repo === `` || !Number.isInteger(runId) || runId <= 0 ? undefined : { repo, runId };
};

export const runInput = (run: RunRef): SideViewInput => ({ repo: run.repo, runId: run.runId });

export const runOf = (response: CiRunsResponse, ref: RunRef): PipelineRun | undefined =>
    response.runs.find((run) => run.repo === ref.repo && run.runId === ref.runId);

// A run's page on its forge, in the shape each forge gives one after the project's path.
const RUN_PAGES = [/^https?:\/\/[^/]+\/(.+?)\/actions\/runs\/(\d+)(?:[/?#]|$)/u, /^https?:\/\/[^/]+\/(.+?)\/-\/pipelines\/(\d+)(?:[/?#]|$)/u];

// Whether `url` is the run's own page or somewhere under it (one of its jobs, an attempt).
const under = (url: string, page: string): boolean => url === page || [`/`, `?`, `#`].some((next) => url.startsWith(`${page}${next}`));

// A link the chat renders to one of the workspace's CI runs: the run it names, read off what the extension already holds
// (a known run's own page, else a project it watches and a run number in its path). Anything else is not this view's.
export const claimRunUrl = (url: string, response: CiRunsResponse): SideViewInput | undefined => {
    const known = response.runs.find((run) => under(url, run.url));
    if (known !== undefined) {
        return runInput(known);
    }
    for (const page of RUN_PAGES) {
        const match = page.exec(url);
        const project = match?.[1]?.toLowerCase();
        const runId = Number(match?.[2]);
        const repo = response.repos.find((entry) => entry.project.toLowerCase() === project)?.repo;
        if (repo !== undefined && Number.isInteger(runId)) {
            return runInput({ repo, runId });
        }
    }
    return undefined;
};

// The tab's words: the workflow and number while the run is known, its number alone before the runs are read.
export const describeRun = (input: SideViewInput, response: CiRunsResponse): SideViewLabel => {
    const ref = runRefOf(input);
    const run = ref === undefined ? undefined : runOf(response, ref);
    const number = `#${ref?.runId ?? ``}`;
    if (run === undefined) {
        return { title: t(`runSide.run`, { number }), icon: `pipelines`, tooltip: ref?.repo };
    }
    return {
        title: run.workflow === undefined ? t(`runSide.run`, { number }) : `${run.workflow} ${number}`,
        icon: `pipelines`,
        tooltip: `${run.repo} · ${run.branch} · ${STATUS_TONE[run.status].label}`,
    };
};

// The board, narrowed to the run's repository: what "Open in Pipelines" shows, and where a phone goes instead.
export const runHome = (input: SideViewInput): string | undefined => {
    const ref = runRefOf(input);
    return ref === undefined ? undefined : `/ext/pipelines?repo=${encodeURIComponent(ref.repo)}`;
};

// Where the run lives on its forge: its own page while it is on the list, else built from the repository's page the
// way each forge lays one out.
export const forgeRunUrl = (ref: RunRef, run: PipelineRun | undefined, repo: CiRepo | undefined): string | undefined => {
    if (run !== undefined) {
        return run.url;
    }
    if (repo === undefined) {
        return undefined;
    }
    return repo.host === `gitlab` ? `${repo.url}/-/pipelines/${ref.runId}` : `${repo.url}/actions/runs/${ref.runId}`;
};
