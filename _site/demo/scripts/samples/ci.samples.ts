import type { GroupSamples } from "./context.ts";

export const ciSamples: GroupSamples<`ci`> = ({ pipeline, ci, now }) => {
    const failure = ci.ciRunsResponse(now, { mainFailing: true }).failures?.[0];
    if (failure === undefined) {
        throw new Error(`demo smoke: the fixture holds no CI failure to forget`);
    }
    return {
        runs: undefined,
        jobs: pipeline,
        rerun: pipeline,
        dispatch: pipeline,
        forget: { repo: failure.repo, branch: failure.branch },
        cancel: pipeline,
        fix: pipeline,
    };
};
