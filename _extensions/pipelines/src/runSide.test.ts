import type { CiRepo, CiRunsResponse } from "@intentic/sandbox-contract";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import { messages } from "./i18n";
import { manifest } from "./manifest";
import { claimRunUrl, describeRun, forgeRunUrl, runHome, runRefOf } from "./runSide";
import { pipelineRun } from "./testing";

// One CI run in the editor's side panel: which run a link or a stored tab names, what its tab says, where it lives.

await registerExtensionMessages(extensionIdOf(manifest), messages);

const repo = (over: Partial<CiRepo> & { repo: string }): CiRepo => ({
    host: `github`,
    project: `acme/shop-web`,
    url: `https://github.com/acme/shop-web`,
    ...over,
});

const answer: CiRunsResponse = {
    repos: [repo({ repo: `web` }), repo({ repo: `infra`, host: `gitlab`, project: `acme/ops/infra`, url: `https://gitlab.acme.dev/acme/ops/infra` })],
    runs: [pipelineRun({ runId: 42, workflow: `build` }), pipelineRun({ runId: 43 })],
};

describe(`the links it takes`, () => {
    it(`takes a listed run's own page, and any page under it`, () => {
        expect(claimRunUrl(`https://github.com/acme/shop-web/actions/runs/42`, answer)).toEqual({ repo: `web`, runId: 42 });
        expect(claimRunUrl(`https://github.com/acme/shop-web/actions/runs/42/job/9001`, answer)).toEqual({ repo: `web`, runId: 42 });
        expect(claimRunUrl(`https://github.com/acme/shop-web/actions/runs/42?pr=7`, answer)).toEqual({ repo: `web`, runId: 42 });
    });

    it(`takes a run older than the list, in a project the workspace watches, on either forge`, () => {
        expect(claimRunUrl(`https://github.com/Acme/Shop-Web/actions/runs/7`, answer)).toEqual({ repo: `web`, runId: 7 });
        expect(claimRunUrl(`https://gitlab.acme.dev/acme/ops/infra/-/pipelines/318`, answer)).toEqual({ repo: `infra`, runId: 318 });
    });

    it(`leaves another project's run, a run number that runs on into more digits, and every other page to the browser`, () => {
        expect(claimRunUrl(`https://github.com/someone/else/actions/runs/42`, answer)).toBeUndefined();
        expect(claimRunUrl(`https://github.com/acme/shop-web/actions/runs/4200`, answer)).toEqual({ repo: `web`, runId: 4200 });
        expect(claimRunUrl(`https://github.com/acme/shop-web/pull/12`, answer)).toBeUndefined();
        expect(claimRunUrl(`https://github.com/acme/shop-web/actions`, answer)).toBeUndefined();
    });
});

describe(`what a tab says`, () => {
    it(`names a listed run by its workflow and number, and says where it ran and how it went`, () => {
        expect(describeRun({ repo: `web`, runId: 42 }, answer)).toEqual({ title: `build #42`, icon: `pipelines`, tooltip: `web · main · failed` });
    });

    it(`names a run without a workflow, or not listed yet, by its number`, () => {
        expect(describeRun({ repo: `web`, runId: 43 }, answer).title).toBe(`Run #43`);
        expect(describeRun({ repo: `web`, runId: 7 }, answer)).toEqual({ title: `Run #7`, icon: `pipelines`, tooltip: `web` });
    });
});

describe(`a tab's input read back`, () => {
    it(`reads a repository and a run number, and nothing else`, () => {
        expect(runRefOf({ repo: `web`, runId: 42 })).toEqual({ repo: `web`, runId: 42 });
        expect(runRefOf({ repo: ``, runId: 42 })).toBeUndefined();
        expect(runRefOf({ repo: `web`, runId: `soon` })).toBeUndefined();
        expect(runRefOf({ repo: `web`, runId: 0 })).toBeUndefined();
    });

    it(`sends "Open in Pipelines" to the board narrowed to the run's repository`, () => {
        expect(runHome({ repo: `web`, runId: 42 })).toBe(`/ext/pipelines?repo=web`);
        expect(runHome({ runId: 42 })).toBeUndefined();
    });
});

describe(`where a run lives on its forge`, () => {
    it(`is a listed run's own page, else built from its repository's the way each forge lays one out`, () => {
        const listed = answer.runs[0];
        expect(forgeRunUrl({ repo: `web`, runId: 42 }, listed, answer.repos[0])).toBe(`https://github.com/acme/shop-web/actions/runs/42`);
        expect(forgeRunUrl({ repo: `web`, runId: 7 }, undefined, answer.repos[0])).toBe(`https://github.com/acme/shop-web/actions/runs/7`);
        expect(forgeRunUrl({ repo: `infra`, runId: 318 }, undefined, answer.repos[1])).toBe(`https://gitlab.acme.dev/acme/ops/infra/-/pipelines/318`);
        expect(forgeRunUrl({ repo: `gone`, runId: 1 }, undefined, undefined)).toBeUndefined();
    });
});
