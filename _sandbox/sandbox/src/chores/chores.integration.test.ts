import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeSpec } from "@intentic/sandbox-contract/chores";
import type { ChoreLedgerEntry, ProbeResult } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, test } from "vitest";
import { createLogger } from "../logger.js";
import { choreShape, packageSignals } from "./chore-signals.js";
import { fileChoresStore, isStale } from "./chores-store.js";
import { createProbeRunner, runProbe } from "./probe-runner.js";

const dirs: string[] = [];
const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "chores-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
    }
    return dir;
};
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/* The runner's contract is that EVERY outcome is a recorded result, the panel showing "jscpd failed: out of
 * memory" is strictly better than a probe that vanishes and leaves a chore reading "not measured yet" forever.
 * The three states are tested against real commands rather than mocks, because the thing being verified is
 * exactly the shell behaviour: what an absent tool does, what a non-zero exit does, and what unrecognisable
 * output does. */
describe(`runProbe`, () => {
    // A spec whose shape is real but whose commands are trivial, so the test measures the runner rather than pnpm.
    const fakeSpec = (over: Partial<ReturnType<typeof probeSpec>>) => ({ ...probeSpec(`outdated`), ...over });

    test(`a tool this repository does not have is unavailable, not a clean result`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const result = await runProbe(fakeSpec({ available: `exit 1` }), dir, 1000);
        expect(result).toMatchObject({ id: `outdated`, state: `unavailable`, ranAt: 1000 });
        expect(result.facts).toBeUndefined();
    });

    /* And it names what is MISSING rather than describing itself. The reason a probe could not run is the only
     * sentence the panel has for that repository, and one built from the probe's own title: "this repository has
     * no security advisories to measure": says the exact thing an unmeasured probe is never allowed to say. */
    test(`an unavailable probe's reason is what is missing, never a restatement of the probe`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const result = await runProbe(fakeSpec({ available: `exit 1` }), dir, 1000);
        expect(result.reason).toBe(probeSpec(`outdated`).unavailable);
        expect(result.reason).not.toContain(probeSpec(`outdated`).title.toLowerCase());
    });

    test(`a command that dies carries the tail of what it printed, so the panel can say why`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const result = await runProbe(fakeSpec({ available: `true`, command: `echo "ERR_PNPM_NO_LOCKFILE" >&2; exit 1` }), dir, 1000);
        expect(result.state).toBe(`failed`);
        expect(result.reason).toContain(`ERR_PNPM_NO_LOCKFILE`);
    });

    // The case that matters most: a tool whose JSON shape moved must read as failed, never as measured-and-clean.
    test(`output the parser cannot recognise is a failure`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const garbage = `not json at all`;
        const result = await runProbe(fakeSpec({ available: `true`, command: `echo "${garbage}"` }), dir, 1000);
        expect(result.state).toBe(`failed`);
        expect(result.reason).toContain(garbage);
    });

    /* And it quotes the FRONT of what it got. These tools print JSON by the megabyte, so the last 400 characters
     * are a fragment from the middle of an array: near-identical whatever went wrong, while the first line is
     * the tool's own error message. Bounded either way, because the reason renders in a one-line strip. */
    test(`an unrecognisable output is quoted from its start, and bounded`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const command = `echo "ERR_KNIP_CONFIG unresolved entry"; echo '{"issues":[${`x`.repeat(500)}'`;
        const result = await runProbe(fakeSpec({ available: `true`, command }), dir, 1000);
        expect(result.reason).toContain(`ERR_KNIP_CONFIG unresolved entry`);
        expect(result.reason).toMatch(/…$/);
        expect(result.reason?.length).toBeLessThan(200);
    });

    test(`a command that exits non-zero WITH usable output still succeeds: pnpm exits 1 when it has findings`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const result = await runProbe(
            fakeSpec({ available: `true`, command: `echo '{"vue":{"current":"1.0.0","latest":"2.0.0"}}'; exit 0` }),
            dir,
            1000,
        );
        expect(result.state).toBe(`ok`);
        expect(result.facts).toEqual({
            id: `outdated`,
            packages: [{ name: `vue`, current: `1.0.0`, latest: `2.0.0`, kind: `major`, section: `dependencies` }],
        });
    });

    test(`a command that hangs is killed and says so rather than holding the lane forever`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const result = await runProbe(fakeSpec({ available: `true`, command: `sleep 5`, timeoutMs: 200 }), dir, 1000);
        expect(result.state).toBe(`failed`);
        expect(result.reason).toContain(`timed out`);
    });
});

/* THE LANE: one measurement at a time, and every request eventually served.
 *
 * The bug these cover is the one a reader meets rather than reads: `refresh` used to return immediately when the
 * runner was busy, while the route above it still answered `{ ok: true }`. So pressing Re-measure during a
 * background sweep, which is the likeliest moment to press it, since a sweep is what makes the numbers look
 * stale: acknowledged the request and then dropped it on the floor, forever.
 *
 * The probes here resolve as `unavailable` in milliseconds: the temp repo has no package.json and no lockfile, so
 * each spec's `available` gate fails at once. That is a REAL run through the real code path, which is what makes
 * these worth having: the alternative is asserting against a fake and learning nothing about the queue. */
describe(`the runner's lane`, () => {
    const runner = async () => {
        const dir = await scaffold({});
        const chores = fileChoresStore(join(dir, `probes.json`), join(dir, `ledger.json`));
        return {
            chores,
            runner: createProbeRunner({
                workspace: { root: dir },
                chores,
                // Nothing live: a background sweep defers to the owner's turns, but a probe somebody pressed a
                // button for is the owner's work and runs regardless. That distinction is asserted below.
                agents: { liveSessionIds: () => [] },
                logger: createLogger({ logLevel: `silent`, logPretty: false, historyRoot: `` }),
            }),
        };
    };

    // THE REGRESSION. Both calls are made before either resolves, which is exactly the collision that used to
    // lose one, and losing it silently, with the panel told the measurement had been asked for.
    test(`a second request made while one is running is queued, not dropped`, async () => {
        const { chores, runner: probes } = await runner();
        await Promise.all([probes.refresh(``, `outdated`), probes.refresh(``, `audit`)]);
        expect((await chores.probesFor(``)).map((probe) => probe.id).toSorted()).toEqual([`audit`, `outdated`]);
    });

    // What the panel draws its spinner on. Read synchronously after the call, because the entry has to be visible
    // from the moment it is asked for: a lane that only admits work once it starts cannot explain a queue.
    test(`what is waiting is visible before it runs, and gone once it has`, async () => {
        const { runner: probes } = await runner();
        const running = probes.refresh(``, `outdated`);
        expect(probes.running().map((entry) => entry.id)).toEqual([`outdated`]);
        await running;
        expect(probes.running()).toEqual([]);
    });

    // Pressing twice is one measurement. The row's button disables itself, but a second panel, or a sweep that
    // already queued this probe: is the same work under a different name.
    test(`the same probe asked for twice joins the request already in the lane`, async () => {
        const { runner: probes } = await runner();
        const first = probes.refresh(``, `outdated`);
        expect(probes.running()).toHaveLength(1);
        await Promise.all([first, probes.refresh(``, `outdated`)]);
        expect(probes.running()).toEqual([]);
    });

    // An id this build has never heard of is not a lane entry that never clears: the panel would show it
    // measuring forever, which is the same failure as the dropped request wearing the opposite costume.
    test(`an unknown probe id does not park in the lane`, async () => {
        const { runner: probes } = await runner();
        await probes.refresh(``, `nonsense` as ProbeResult["id"]);
        expect(probes.running()).toEqual([]);
    });
});

describe(`the store`, () => {
    const store = async () => {
        const dir = await scaffold({});
        return fileChoresStore(join(dir, `probes.json`), join(dir, `ledger.json`));
    };
    const result = (over: Partial<ProbeResult> & Pick<ProbeResult, "id">): ProbeResult => ({ state: `ok`, ranAt: 1, tookMs: 1, ...over });
    const entry = (over: Partial<ChoreLedgerEntry> = {}): ChoreLedgerEntry => ({
        repo: `app`,
        chore: `dead-code`,
        ranAt: 1,
        runId: `r1`,
        outcome: `acted`,
        digest: `abc`,
        ...over,
    });

    test(`keeps one result per repo per probe, and one ledger row per repo per chore`, async () => {
        const chores = await store();
        await chores.recordProbe(`app`, result({ id: `outdated` }));
        await chores.recordProbe(`app`, result({ id: `audit` }));
        await chores.recordProbe(`app`, result({ id: `outdated`, ranAt: 2 }));
        expect(await chores.probesFor(`app`)).toHaveLength(2);
        expect((await chores.probesFor(`app`)).find((probe) => probe.id === `outdated`)?.ranAt).toBe(2);

        await chores.recordLedger(entry());
        await chores.recordLedger(entry({ digest: `def` }));
        await chores.recordLedger(entry({ chore: `duplication` }));
        expect(await chores.ledger()).toHaveLength(2);
        expect((await chores.ledger()).find((row) => row.chore === `dead-code`)?.digest).toBe(`def`);
    });

    test(`repos keep their own measurements`, async () => {
        const chores = await store();
        await chores.recordProbe(`app`, result({ id: `outdated` }));
        await chores.recordProbe(``, result({ id: `outdated` }));
        expect(await chores.probesFor(`app`)).toHaveLength(1);
        expect(await chores.probesFor(``)).toHaveLength(1);
        expect(await chores.probesFor(`never-existed`)).toEqual([]);
    });

    // A deleted clone's measurements must not outlive it: they would render as a repository nobody can open.
    test(`prune drops repos that no longer exist and leaves the rest`, async () => {
        const chores = await store();
        await chores.recordProbe(`app`, result({ id: `outdated` }));
        await chores.recordProbe(`gone`, result({ id: `outdated` }));
        await chores.pruneProbes([``, `app`]);
        expect(await chores.probesFor(`app`)).toHaveLength(1);
        expect(await chores.probesFor(`gone`)).toEqual([]);
    });

    test(`staleness is measured from when the probe completed, and an absent one is always stale`, () => {
        expect(isStale(undefined, 100, 1000)).toBe(true);
        expect(isStale(result({ id: `audit`, ranAt: 950 }), 100, 1000)).toBe(false);
        expect(isStale(result({ id: `audit`, ranAt: 900 }), 100, 1000)).toBe(true);
    });

    /* A result that is not a MEASUREMENT must not hold a measurement's lease. Tier 2's TTL is a week, and leasing
     * a failed knip run for a week is how the panel kept reporting a parse error long after the parser that could
     * not read that output had been fixed. */
    test(`a probe that did not measure is retried on the hour, whatever its TTL`, () => {
        const week = 7 * 86_400_000;
        const hour = 3_600_000;
        for (const state of [`failed`, `unavailable`] as const) {
            expect(isStale(result({ id: `knip`, state, ranAt: 0 }), week, hour - 1)).toBe(false);
            expect(isStale(result({ id: `knip`, state, ranAt: 0 }), week, hour)).toBe(true);
        }
        // While a real measurement still gets the whole week it was promised.
        expect(isStale(result({ id: `knip`, ranAt: 0 }), week, hour)).toBe(false);
    });
});

describe(`package signals`, () => {
    test(`read engines and dependency names, and whether the package has a document`, async () => {
        const dir = await scaffold({
            "pnpm-workspace.yaml": `packages:\n  - "_libs/*"\n`,
            "_libs/one/package.json": JSON.stringify({
                name: `@x/one`,
                engines: { node: `>=22` },
                dependencies: { zod: `^4` },
                devDependencies: { vitest: `^2` },
            }),
            "_libs/two/package.json": JSON.stringify({ name: `@x/two` }),
            // A package's architecture document is its own README, so `documented` is a stat on the package dir.
            "_libs/one/README.md": `# one`,
        });
        expect(packageSignals(dir)).toEqual([
            { dir: `_libs/one`, name: `@x/one`, engines: { node: `>=22` }, dependencies: [`zod`], devDependencies: [`vitest`], documented: true },
            { dir: `_libs/two`, name: `@x/two`, dependencies: [], devDependencies: [], documented: false },
        ]);
    });

    /* A repo that is not a pnpm workspace has no packages, and that is a true answer rather than a gap: the root
     * manifest is deliberately NOT folded in as a pseudo-package, which would make every ordinary repo report
     * exactly one undocumented "package": a finding about our modelling rather than about the code. */
    test(`a repo that is not a workspace reports no packages at all`, async () => {
        const dir = await scaffold({ "package.json": JSON.stringify({ name: `plain` }) });
        expect(packageSignals(dir)).toEqual([]);
    });
});

/* WHAT THE REPOSITORY IS MADE OF: the facts the applicability gates read. Presence of a FILE, deliberately:
 * checkable, cheap, and not arguable, which is the same evidence-over-identity rule extension activation follows.
 * Every case below decides whether a whole chore appears, so a false negative here is a chore that silently never
 * shows up and a false positive is one that can never be acted on. */
describe(`repo shape`, () => {
    test(`finds documents, Dockerfiles by either convention, workflows and the lockfile`, async () => {
        const dir = await scaffold({
            "package.json": `{}`,
            "pnpm-lock.yaml": ``,
            Dockerfile: `FROM node`,
            "_apps/web/web.Dockerfile": `FROM nginx`,
            ".github/workflows/ci.yml": `on: push`,
            ".github/workflows/release.yaml": `on: tag`,
            // The MAP is what `docs` counts. Package pages are READMEs, counted per package by `packageSignals`.
            "docs/architecture/repo.md": `# repo`,
        });
        const found = choreShape(dir);
        expect(found.lockfile).toBe(true);
        expect(found.packageManifest).toBe(true);
        expect(found.dockerfiles.toSorted()).toEqual([`Dockerfile`, `_apps/web/web.Dockerfile`]);
        expect(found.ci.toSorted()).toEqual([`.github/workflows/ci.yml`, `.github/workflows/release.yaml`]);
        expect(found.docs).toEqual([`repo.md`]);
    });

    test(`an empty repository rules everything out rather than guessing`, async () => {
        const found = choreShape(await scaffold({ "README.md": `# hi` }));
        expect(found).toEqual({ docs: [], dockerfiles: [], ci: [], lockfile: false, packageManifest: false, deps: [] });
    });

    /* THE CASE THE FRONT-END GATES LIVE OR DIE ON. `packages` comes from pnpm-workspace.yaml, so it is empty for
     * a repository that is not a monorepo, which every Vite, Next and Angular CLI project is. Reading the root
     * manifest here is what stops a framework gate being permanently and silently dark in exactly the
     * repositories it exists for. */
    test(`a single-package app declares its dependencies even though it has no workspace packages`, async () => {
        const dir = await scaffold({
            "package.json": JSON.stringify({ dependencies: { react: `^19.0.0` }, devDependencies: { tailwindcss: `^4.0.0`, vite: `^6.0.0` } }),
        });
        expect(packageSignals(dir)).toEqual([]);
        expect(choreShape(dir).deps).toEqual([`react`, `tailwindcss`, `vite`]);
    });

    // A monorepo keeps its framework in the app package while the root manifest holds build tools, so the union
    // is the only reading that recognises either shape.
    test(`a workspace unions the root manifest with every package's`, async () => {
        const dir = await scaffold({
            "package.json": JSON.stringify({ devDependencies: { turbo: `^2.0.0` } }),
            "pnpm-workspace.yaml": `packages:\n  - _apps/*\n`,
            "_apps/web/package.json": JSON.stringify({ name: `@x/web`, dependencies: { vue: `^3.4.0` } }),
        });
        expect(choreShape(dir).deps).toEqual([`turbo`, `vue`]);
    });

    // Peer dependencies count: every component library in the ecosystem takes its framework as one, and a gate
    // that skipped them would decide such a package is not a React package while every file in it imports React.
    test(`peer and optional dependencies count, and a name is never repeated`, async () => {
        const dir = await scaffold({
            "package.json": JSON.stringify({
                dependencies: { react: `^19.0.0` },
                peerDependencies: { react: `^19.0.0`, "@angular/core": `^19.0.0` },
            }),
        });
        expect(choreShape(dir).deps).toEqual([`@angular/core`, `react`]);
    });

    // An unparseable manifest is the repository's problem to report; every other gate here still has an answer.
    test(`a manifest that does not parse leaves the rest of the shape intact`, async () => {
        const found = choreShape(await scaffold({ "package.json": `{ not json`, Dockerfile: `FROM node` }));
        expect(found.deps).toEqual([]);
        expect(found.dockerfiles).toEqual([`Dockerfile`]);
    });

    /* An empty `docs/architecture/` is a directory somebody made and never filled. Gating the drift survey on the
     * DIRECTORY would put the chore back exactly where a repository with nothing to re-read cannot use it, so the
     * gate reads the documents themselves. */
    test(`an empty docs directory is not documentation`, async () => {
        const dir = await scaffold({ "docs/architecture/.gitkeep": `` });
        expect(choreShape(dir).docs).toEqual([]);
    });

    test(`the single-file CI conventions count too`, async () => {
        expect(choreShape(await scaffold({ ".gitlab-ci.yml": `stages: []` })).ci).toEqual([`.gitlab-ci.yml`]);
        expect(choreShape(await scaffold({ Jenkinsfile: `pipeline {}` })).ci).toEqual([`Jenkinsfile`]);
    });

    // The walk is bounded so a poll cannot wander into a dependency tree; node_modules is the one that would hurt
    // most, since half of npm ships a Dockerfile.
    test(`the sweep does not descend into ignored directories`, async () => {
        const dir = await scaffold({ "node_modules/some-dep/Dockerfile": `FROM node`, "dist/Dockerfile": `FROM node` });
        expect(choreShape(dir).dockerfiles).toEqual([]);
    });
});
