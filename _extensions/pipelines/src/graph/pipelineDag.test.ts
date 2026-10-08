import type { PipelineJob } from "@intentic/sandbox-contract";
import { jobLineage, jobName, pipelineDag, pipelineStages, stageOfNode } from "./pipelineDag";

// Pins how a run's job graph draws: node/edge shape from declared dependencies (falling back to time overlap), and that
// clustering groups jobs without losing per-job counts.

const staged = (name: string, stage: string): PipelineJob => ({ name, status: `success`, stage });
const declared = (name: string, needs: string[], startedAt: number): PipelineJob => ({
    name,
    status: `success`,
    needs,
    startedAt,
    finishedAt: startedAt + 1_000,
});

// GitLab's shape: build[lint, compile] → test[unit, e2e] → deploy[ship]
const stageRun = pipelineStages([
    staged(`lint`, `build`),
    staged(`compile`, `build`),
    staged(`unit`, `test`),
    staged(`e2e`, `test`),
    staged(`ship`, `deploy`),
]);

// Every job starts at a different, non-overlapping time; branching comes only from `needs`, not timestamps.
const declaredRun = pipelineStages([
    declared(`preflight`, [], 0),
    declared(`changes`, [], 10_000),
    declared(`verify-core / verify`, [`preflight`], 20_000),
    declared(`verify-site / verify`, [`preflight`], 30_000),
    declared(`images`, [`verify-core / verify`], 40_000),
    declared(`release`, [`images`, `changes`], 50_000),
]);

// The real run of intentic's CI that GitHub drew one way and this graph another (run 37802381002), as the sandbox now
// serves it: every job the workflow declares, the ones the run never reported included.
const intenticRun: PipelineJob[] = (
    [
        [`changes`, `success`, []],
        [`preflight`, `success`, []],
        [`quick`, `failed`, [`changes`, `preflight`]],
        [`migrations`, `success`, [`changes`, `preflight`]],
        [`ci-base`, `success`, [`changes`]],
        [`ci-desktop`, `success`, [`changes`, `ci-base`]],
        [`verify-core / verify`, `success`, [`preflight`, `ci-base`]],
        [`verify-platform / verify`, `success`, [`preflight`]],
        [`verify-providers`, `success`, [`preflight`]],
        [`verify-clocks`, `success`, [`preflight`, `ci-base`]],
        [`verify-machine`, `success`, [`preflight`, `ci-base`]],
        [`perf-instr`, `success`, [`changes`, `preflight`]],
        [`perf-browser`, `success`, [`changes`, `preflight`]],
        [`local-face`, `failed`, [`changes`, `preflight`]],
        [`desktop-check`, `success`, [`changes`, `preflight`, `ci-base`, `ci-desktop`]],
        [`ic-check`, `success`, [`changes`, `preflight`, `ci-base`, `ci-desktop`]],
        [`netd-check`, `failed`, [`changes`, `preflight`, `ci-base`, `ci-desktop`]],
        [`desktop-verify`, `skipped`, [`changes`, `preflight`, `ci-base`, `ci-desktop`]],
        [`desktop-windows-build`, `skipped`, [`changes`, `preflight`, `ci-base`, `ci-desktop`]],
        [`e2e-billing`, `success`, [`changes`, `preflight`]],
        [`e2e-signin`, `success`, [`changes`, `preflight`]],
        [`e2e-hermetic`, `skipped`, [`preflight`]],
        [
            `images`,
            `skipped`,
            [
                `changes`,
                `preflight`,
                `verify-machine`,
                `netd-check`,
                `verify-core / verify`,
                `release / device-android / build`,
                `release / device-android / release`,
            ],
        ],
        [
            `images-dry`,
            `skipped`,
            [
                `changes`,
                `preflight`,
                `verify-machine`,
                `netd-check`,
                `verify-core / verify`,
                `release / device-android / build`,
                `release / device-android / release`,
            ],
        ],
        [
            `images-arm64`,
            `skipped`,
            [
                `changes`,
                `preflight`,
                `verify-machine`,
                `netd-check`,
                `verify-core / verify`,
                `release / device-android / build`,
                `release / device-android / release`,
            ],
        ],
        [`images-merge`, `skipped`, [`images`, `images-arm64`]],
        [`images-platform`, `skipped`, [`changes`, `preflight`, `migrations`, `e2e-billing`, `e2e-signin`, `netd-check`, `verify-platform / verify`]],
        [
            `desktop-verify-windows / smoke`,
            `skipped`,
            [`desktop-windows-build`, `release / device-android / build`, `release / device-android / release`],
        ],
        [`release / device-android / build`, `skipped`, [`release / plan`, `release / publish`]],
        [`release / device-android / release`, `skipped`, [`release / plan`, `release / publish`]],
        [`release / images-amd64`, `skipped`, [`release / plan`]],
        [`release / linux-build`, `skipped`, [`release / plan`]],
        [
            `release / plan`,
            `skipped`,
            [`preflight`, `verify-providers`, `verify-machine`, `netd-check`, `ci-base`, `ci-desktop`, `verify-core / verify`],
        ],
        [
            `release / publish`,
            `skipped`,
            [`release / plan`, `release / sandbox-arm64`, `release / images-amd64`, `release / linux-build`, `release / windows-verify / smoke`],
        ],
        [`release / sandbox-arm64`, `skipped`, [`release / plan`]],
        [`release / windows-build`, `skipped`, [`release / plan`]],
        [`release / windows-verify / smoke`, `skipped`, [`release / plan`, `release / windows-build`]],
    ] as const
).map(([name, status, needs]) => ({ name, status, needs: [...needs], declaredId: name.split(` / `).join(`.`) }));

// Columns of cards, each card its job names in row order, top to bottom.
const columnsOf = (jobs: readonly PipelineJob[]): string[][][] => {
    const dag = pipelineDag(pipelineStages(jobs));
    const columns = new Map<number, { order: number; names: string[] }[]>();
    for (const node of dag.nodes) {
        const column = stageOfNode(node.id);
        columns.set(column, [...(columns.get(column) ?? []), { order: node.order ?? -1, names: node.data.jobs.map((member) => member.job.name) }]);
    }
    return [...columns.keys()]
        .toSorted((one, other) => one - other)
        .map((column) => (columns.get(column) ?? []).toSorted((one, other) => one.order - other.order).map((card) => card.names));
};

describe(`pipelineDag draws a declared run as GitHub does`, () => {
    it(`places every card of a real run in GitHub's column, at GitHub's place, with GitHub's rows`, () => {
        // Read off GitHub's own page for the run.
        expect(columnsOf(intenticRun)).toEqual([
            [[`preflight`], [`changes`]],
            [
                [`verify-platform / verify`],
                [`verify-providers`],
                [`e2e-hermetic`],
                [`ci-base`],
                [`migrations`, `e2e-billing`, `e2e-signin`],
                [`quick`, `perf-instr`, `perf-browser`, `local-face`],
            ],
            [[`ci-desktop`], [`verify-core / verify`, `verify-machine`], [`verify-clocks`]],
            [[`netd-check`], [`desktop-windows-build`], [`desktop-check`, `ic-check`, `desktop-verify`]],
            [[`release / plan`], [`images-platform`]],
            [[`release / images-amd64`, `release / linux-build`, `release / sandbox-arm64`], [`release / windows-build`]],
            [[`release / windows-verify / smoke`]],
            [[`release / publish`]],
            [[`release / device-android / build`, `release / device-android / release`]],
            [[`images`, `images-arm64`], [`images-dry`], [`desktop-verify-windows / smoke`]],
            [[`images-merge`]],
        ]);
    });

    it(`gives every card a place in its column, so the layout draws that order rather than its own`, () => {
        expect(pipelineDag(pipelineStages(intenticRun)).nodes.every((node) => node.order !== undefined)).toBe(true);
        // Stages and waves carry no picture to reproduce: those keep the layout's own ordering.
        expect(pipelineDag(stageRun).nodes.every((node) => node.order === undefined)).toBe(true);
    });

    it(`keeps a matrix's legs in a card of their own, ahead of plain jobs wired the same way`, () => {
        const leg = (name: string): PipelineJob => ({ name, status: `success`, needs: [`build`], declaredId: `e2e`, matrix: `e2e` });
        const plain = (name: string): PipelineJob => ({ name, status: `success`, needs: [`build`], declaredId: name });
        const run = [plain(`build`), plain(`lint`), leg(`e2e (chromium)`), leg(`e2e (firefox)`), plain(`docs`)].map((job, index) =>
            index === 0 ? { ...job, needs: [] } : job,
        );
        // GitHub keys a matrix `build|-e2e-|`, a plain card `build|`: the plain card's key is the shorter, so it sorts first
        // when both lead nowhere.
        expect(columnsOf(run)).toEqual([
            [[`build`]],
            [
                [`lint`, `docs`],
                [`e2e (chromium)`, `e2e (firefox)`],
            ],
        ]);
    });

    it(`puts a card under the last card it waits on, and the card more jobs wait on higher`, () => {
        const job = (name: string, needs: string[]): PipelineJob => ({ name, status: `success`, needs, declaredId: name });
        const run = [
            job(`a`, []),
            job(`b`, []),
            // Waits on the bottom root only: below everything waiting on the top one.
            job(`only-b`, [`b`]),
            job(`both`, [`a`, `b`]),
            job(`only-a`, [`a`]),
            // Nothing waits on `only-a`; `feeds` has a dependent, so it rises above it.
            job(`feeds`, [`a`]),
            job(`next`, [`feeds`]),
        ];
        expect(columnsOf(run)).toEqual([[[`a`], [`b`]], [[`feeds`], [`only-a`], [`only-b`], [`both`]], [[`next`]]]);
    });
});

describe(`jobName`, () => {
    it(`splits a called workflow's job into the calls it came through and its own name, and leaves the rest alone`, () => {
        expect(jobName(`release / windows-verify / smoke`)).toEqual({ caller: `release / windows-verify`, title: `smoke` });
        expect(jobName(`verify-core / verify`)).toEqual({ caller: `verify-core`, title: `verify` });
        expect(jobName(`quick`)).toEqual({ caller: undefined, title: `quick` });
        expect(jobName(`e2e (chromium)`)).toEqual({ caller: undefined, title: `e2e (chromium)` });
    });
});

describe(`pipelineStages`, () => {
    it(`layers a declared run by dependency depth, not by when things happened to start`, () => {
        // Six non-overlapping jobs would make six waves; dependency depth makes four.
        expect(declaredRun.map((stage) => stage.jobs.map((job) => job.name))).toEqual([
            [`preflight`, `changes`],
            [`verify-core / verify`, `verify-site / verify`],
            [`images`],
            [`release`],
        ]);
    });

    it(`still groups by vendor stage when nothing is declared`, () => {
        expect(stageRun.map((stage) => stage.name)).toEqual([`build`, `test`, `deploy`]);
    });

    it(`falls back to execution waves when there is neither`, () => {
        const overlapping: PipelineJob[] = [
            { name: `a`, status: `success`, startedAt: 0, finishedAt: 100 },
            { name: `b`, status: `success`, startedAt: 10, finishedAt: 90 },
            { name: `c`, status: `success`, startedAt: 200, finishedAt: 300 },
        ];
        expect(pipelineStages(overlapping).map((stage) => stage.jobs.map((job) => job.name))).toEqual([[`a`, `b`], [`c`]]);
    });

    // Queued jobs carry no start time; they still land in a trailing wave.
    it(`puts the jobs still waiting for a runner in a trailing wave`, () => {
        const held: PipelineJob[] = [
            { name: `ci-audit`, status: `success`, startedAt: 0, finishedAt: 100 },
            { name: `e2e`, status: `queued` },
            { name: `images`, status: `queued` },
        ];
        const stages = pipelineStages(held);
        expect(stages.map((stage) => stage.jobs.map((job) => job.name))).toEqual([[`ci-audit`], [`e2e`, `images`]]);
        // Circle, not spinner: nothing in a queued wave is executing.
        expect(stages.map((stage) => stage.status)).toEqual([`success`, `queued`]);
    });

    it(`reads a half-started stage as started, and a failure still dominates both`, () => {
        const worstOf = (jobs: PipelineJob[]): string | undefined => pipelineStages(jobs)[0]?.status;
        // One leg running while its siblings queue still counts as the stage running.
        expect(
            worstOf([
                { name: `a`, status: `running`, stage: `test` },
                { name: `b`, status: `queued`, stage: `test` },
            ]),
        ).toBe(`running`);
        expect(
            worstOf([
                { name: `a`, status: `queued`, stage: `test` },
                { name: `b`, status: `success`, stage: `test` },
            ]),
        ).toBe(`queued`);
        expect(
            worstOf([
                { name: `a`, status: `queued`, stage: `test` },
                { name: `b`, status: `failed`, stage: `test` },
            ]),
        ).toBe(`failed`);
    });
});

describe(`pipelineDag with declared dependencies`, () => {
    it(`draws one edge per declared dependency, not a stage-wide join`, () => {
        // Every job has a unique edge signature, so each stays its own cluster node; edges match the unclustered graph.
        const edges = pipelineDag(declaredRun).edges.map((edge) => `${edge.from}>${edge.to}`);
        expect(edges.toSorted()).toEqual([`0:0>1:0`, `0:0>1:1`, `0:1>3:0`, `1:0>2:0`, `2:0>3:0`]);
    });

    it(`traces one leg of a fan-out without lighting its sibling's parents`, () => {
        // `1:1` is `verify-site / verify`: traces its parent `preflight`, not the images/release line.
        const dag = pipelineDag(declaredRun, `1:1`);
        // Each job is its own cluster, so dimmed clusters equal dimmed jobs directly.
        const dimmedNames = dag.nodes
            .filter((node) => node.dimmed === true)
            .flatMap((node) => node.data.jobs.map((m) => m.job.name))
            .toSorted();
        expect(dimmedNames).toEqual([`changes`, `images`, `release`, `verify-core / verify`]);
        expect(dag.trace).toMatchObject({ before: 1, after: 0 });
    });

    it(`reaches transitively both ways from a job in the middle`, () => {
        // `2:0` is `images`: chain is preflight → verify-core → images → release.
        const dag = pipelineDag(declaredRun, `2:0`);
        expect(dag.trace).toMatchObject({ before: 2, after: 1 });
        const traced = dag.edges.filter((edge) => edge.accent === `text-link`).map((edge) => `${edge.from}>${edge.to}`);
        expect(traced.toSorted()).toEqual([`0:0>1:0`, `1:0>2:0`, `2:0>3:0`]);
        // `changes → release` sits off this trace's line, so it stays dimmed.
        expect(dag.edges.find((edge) => edge.from === `0:1`)?.dimmed).toBe(true);
    });
});

describe(`pipelineDag with only stages`, () => {
    it(`clusters jobs with identical edges into compound nodes`, () => {
        // build[lint, compile]: incoming none, outgoing {1:0, 1:1} → one cluster.
        // test[unit, e2e]: incoming {0:0, 0:1}, outgoing {2:0} → one cluster.
        // deploy[ship]: alone.
        const dag = pipelineDag(stageRun);
        expect(dag.nodes).toHaveLength(3);
        // Cluster 0:0 is the build jobs, 1:0 the test jobs, 2:0 is ship.
        expect(dag.nodes.map((n) => n.data.jobs.map((m) => m.job.name))).toEqual([[`lint`, `compile`], [`unit`, `e2e`], [`ship`]]);
        // Only two edges: build-cluster → test-cluster → deploy-cluster.
        expect(dag.edges).toHaveLength(2);
        expect(dag.edges.map((e) => `${e.from}>${e.to}`)).toEqual([`0:0>1:0`, `1:0>2:0`]);
        expect(dag.nodes.every((node) => node.dimmed === undefined)).toBe(true);
        expect(dag.edges.every((edge) => edge.dimmed === undefined && edge.accent === undefined)).toBe(true);
        expect(dag.trace).toBeUndefined();
    });

    it(`fades unrelated clusters when a job is focused`, () => {
        // Focusing `1:0` (test): build and deploy are also on this linear line, so nothing fades.
        const dag = pipelineDag(stageRun, `1:0`);
        expect(dag.nodes.filter((node) => node.dimmed === true)).toEqual([]);
        // Lineage counts jobs, not clusters: 2 build jobs before, 1 deploy job after.
        expect(dag.trace).toMatchObject({ before: 2, after: 1 });
    });

    it(`traces edges on the focused cluster's line`, () => {
        const dag = pipelineDag(stageRun, `1:0`);
        const traced = dag.edges.filter((edge) => edge.accent === `text-link`).map((edge) => `${edge.from}>${edge.to}`);
        // Both cluster edges are on the line (linear pipeline).
        expect(traced.toSorted()).toEqual([`0:0>1:0`, `1:0>2:0`]);
    });
});

describe(`pipelineDag invariants`, () => {
    it(`keeps ids and endpoints identical whatever is focused, so a hover cannot re-lay-out the graph`, () => {
        for (const run of [stageRun, declaredRun]) {
            const shape = (focus?: string): string[] => pipelineDag(run, focus).edges.map((edge) => `${edge.from}>${edge.to}`);
            expect(shape(`1:0`)).toEqual(shape());
            expect(pipelineDag(run, `1:0`).nodes.map((node) => node.id)).toEqual(pipelineDag(run).nodes.map((node) => node.id));
        }
    });

    it(`drops a declared dependency on a job that never ran rather than drawing an edge to nothing`, () => {
        const run = pipelineStages([declared(`build`, [], 0), declared(`ship`, [`build`, `never-ran`], 10_000)]);
        expect(pipelineDag(run).edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual([`0:0>1:0`]);
    });

    it(`survives a workflow that declares a cycle`, () => {
        const run = pipelineStages([declared(`a`, [`b`], 0), declared(`b`, [`a`], 10_000)]);
        expect(
            run
                .flatMap((stage) => stage.jobs)
                .map((job) => job.name)
                .toSorted(),
        ).toEqual([`a`, `b`]);
        expect(() => pipelineDag(run, `0:0`)).not.toThrow();
    });

    it(`draws a run with no edges at all as one card rather than a row of unrelated boxes`, () => {
        // No job waits on anything, so all three share the same empty edge signature.
        const run = pipelineStages([staged(`unit`, `test`), staged(`e2e`, `test`), staged(`lint`, `test`)]);
        const dag = pipelineDag(run);
        expect(dag.nodes.map((node) => node.data.jobs.map((member) => member.job.name))).toEqual([[`unit`, `e2e`, `lint`]]);
        expect(dag.edges).toEqual([]);
    });

    it(`preserves every job inside cluster nodes`, () => {
        for (const run of [stageRun, declaredRun]) {
            const allJobs = run.flatMap((stage) => stage.jobs.map((job) => job.name)).toSorted();
            const clusteredJobs = pipelineDag(run)
                .nodes.flatMap((node) => node.data.jobs.map((m) => m.job.name))
                .toSorted();
            expect(clusteredJobs).toEqual(allJobs);
        }
    });
});

describe(`jobLineage`, () => {
    it(`collects the edges it walked, not every edge between related nodes`, () => {
        // a→b→c plus a bypass a→c: focusing `b` must exclude the bypass, since it passes through neither.
        const links = [
            { from: `a`, to: `b` },
            { from: `b`, to: `c` },
            { from: `a`, to: `c` },
        ];
        const lineage = jobLineage(links, `b`);
        expect([...lineage.nodes].toSorted()).toEqual([`a`, `b`, `c`]);
        expect([...lineage.links].toSorted()).toEqual([`a>b`, `b>c`]);
    });
});
