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

// Every outcome from runProbe is a recorded result, never a silent gap. Tested against real commands, not mocks, since
// what's verified is actual shell behavior: a missing tool, a non-zero exit, unreadable output.
describe(`runProbe`, () => {
    // Real spec shape, trivial commands, so the test measures the runner, not pnpm.
    const fakeSpec = (over: Partial<ReturnType<typeof probeSpec>>) => ({ ...probeSpec(`outdated`), ...over });

    test(`a tool this repository does not have is unavailable, not a clean result`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const result = await runProbe(fakeSpec({ available: `exit 1` }), dir, 1000);
        expect(result).toMatchObject({ id: `outdated`, state: `unavailable`, ranAt: 1000 });
        expect(result.facts).toBeUndefined();
    });

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

    test(`output the parser cannot recognise is a failure`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const garbage = `not json at all`;
        const result = await runProbe(fakeSpec({ available: `true`, command: `echo "${garbage}"` }), dir, 1000);
        expect(result.state).toBe(`failed`);
        expect(result.reason).toContain(garbage);
    });

    // The front is quoted since these tools print megabytes of JSON; the tail is usually mid-array noise, not the
    // error.
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

// One measurement at a time, every request eventually served, exercised through the real run path: probes resolve
// `unavailable` in ms since the temp repo has no manifest.
describe(`the runner's lane`, () => {
    const runner = async () => {
        const dir = await scaffold({});
        const chores = fileChoresStore(join(dir, `probes.json`), join(dir, `ledger.json`));
        return {
            chores,
            runner: createProbeRunner({
                workspace: { root: dir },
                chores,
                // A background sweep defers to live turns; a manually requested probe runs regardless, asserted below.
                agents: { liveSessionIds: () => [] },
                logger: createLogger({ logLevel: `silent`, logPretty: false, historyRoot: `` }),
            }),
        };
    };

    // Both calls are made before either resolves, the exact race that could silently drop one.
    test(`a second request made while one is running is queued, not dropped`, async () => {
        const { chores, runner: probes } = await runner();
        await Promise.all([probes.refresh(``, `outdated`), probes.refresh(``, `audit`)]);
        expect((await chores.probesFor(``)).map((probe) => probe.id).toSorted()).toEqual([`audit`, `outdated`]);
    });

    // Read synchronously right after the call, since the entry must be visible before the probe resolves.
    test(`what is waiting is visible before it runs, and gone once it has`, async () => {
        const { runner: probes } = await runner();
        const running = probes.refresh(``, `outdated`);
        expect(probes.running().map((entry) => entry.id)).toEqual([`outdated`]);
        await running;
        expect(probes.running()).toEqual([]);
    });

    test(`the same probe asked for twice joins the request already in the lane`, async () => {
        const { runner: probes } = await runner();
        const first = probes.refresh(``, `outdated`);
        expect(probes.running()).toHaveLength(1);
        await Promise.all([first, probes.refresh(``, `outdated`)]);
        expect(probes.running()).toEqual([]);
    });

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

    test(`a probe that did not measure is retried on the hour, whatever its TTL`, () => {
        const week = 7 * 86_400_000;
        const hour = 3_600_000;
        for (const state of [`failed`, `unavailable`] as const) {
            expect(isStale(result({ id: `knip`, state, ranAt: 0 }), week, hour - 1)).toBe(false);
            expect(isStale(result({ id: `knip`, state, ranAt: 0 }), week, hour)).toBe(true);
        }
        // A real measurement (state ok) still gets the full week, not the hourly retry.
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
            // A package's doc is its README; `documented` is just a stat on the package dir.
            "_libs/one/README.md": `# one`,
        });
        expect(packageSignals(dir)).toEqual([
            { dir: `_libs/one`, name: `@x/one`, engines: { node: `>=22` }, dependencies: [`zod`], devDependencies: [`vitest`], documented: true },
            { dir: `_libs/two`, name: `@x/two`, dependencies: [], devDependencies: [], documented: false },
        ]);
    });

    // The root manifest is deliberately not counted as a pseudo-package; a plain repo would otherwise report one
    // undocumented package.
    test(`a repo that is not a workspace reports no packages at all`, async () => {
        const dir = await scaffold({ "package.json": JSON.stringify({ name: `plain` }) });
        expect(packageSignals(dir)).toEqual([]);
    });
});

// Checks presence of files only: cheap, checkable, and not arguable. A false negative hides a chore forever; a false
// positive shows one that can never be acted on.
describe(`repo shape`, () => {
    test(`finds documents, Dockerfiles by either convention, workflows and the lockfile`, async () => {
        const dir = await scaffold({
            "package.json": `{}`,
            "pnpm-lock.yaml": ``,
            Dockerfile: `FROM node`,
            "_apps/web/web.Dockerfile": `FROM nginx`,
            ".github/workflows/ci.yml": `on: push`,
            ".github/workflows/release.yaml": `on: tag`,
            // `docs` counts the map (docs/architecture); package READMEs are counted separately by packageSignals.
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

    test(`a single-package app declares its dependencies even though it has no workspace packages`, async () => {
        const dir = await scaffold({
            "package.json": JSON.stringify({ dependencies: { react: `^19.0.0` }, devDependencies: { tailwindcss: `^4.0.0`, vite: `^6.0.0` } }),
        });
        expect(packageSignals(dir)).toEqual([]);
        expect(choreShape(dir).deps).toEqual([`react`, `tailwindcss`, `vite`]);
    });

    test(`a workspace unions the root manifest with every package's`, async () => {
        const dir = await scaffold({
            "package.json": JSON.stringify({ devDependencies: { turbo: `^2.0.0` } }),
            "pnpm-workspace.yaml": `packages:\n  - _apps/*\n`,
            "_apps/web/package.json": JSON.stringify({ name: `@x/web`, dependencies: { vue: `^3.4.0` } }),
        });
        expect(choreShape(dir).deps).toEqual([`turbo`, `vue`]);
    });

    test(`peer and optional dependencies count, and a name is never repeated`, async () => {
        const dir = await scaffold({
            "package.json": JSON.stringify({
                dependencies: { react: `^19.0.0` },
                peerDependencies: { react: `^19.0.0`, "@angular/core": `^19.0.0` },
            }),
        });
        expect(choreShape(dir).deps).toEqual([`@angular/core`, `react`]);
    });

    test(`a manifest that does not parse leaves the rest of the shape intact`, async () => {
        const found = choreShape(await scaffold({ "package.json": `{ not json`, Dockerfile: `FROM node` }));
        expect(found.deps).toEqual([]);
        expect(found.dockerfiles).toEqual([`Dockerfile`]);
    });

    test(`an empty docs directory is not documentation`, async () => {
        const dir = await scaffold({ "docs/architecture/.gitkeep": `` });
        expect(choreShape(dir).docs).toEqual([]);
    });

    test(`the single-file CI conventions count too`, async () => {
        expect(choreShape(await scaffold({ ".gitlab-ci.yml": `stages: []` })).ci).toEqual([`.gitlab-ci.yml`]);
        expect(choreShape(await scaffold({ Jenkinsfile: `pipeline {}` })).ci).toEqual([`Jenkinsfile`]);
    });

    // node_modules is the ignored dir most likely to hide a Dockerfile, since many packages ship one.
    test(`the sweep does not descend into ignored directories`, async () => {
        const dir = await scaffold({ "node_modules/some-dep/Dockerfile": `FROM node`, "dist/Dockerfile": `FROM node` });
        expect(choreShape(dir).dockerfiles).toEqual([]);
    });

    test(`workspace shape skips only the top-level reference shelf`, async () => {
        const dir = await scaffold({
            "refs/upstream/Dockerfile": `FROM hidden`,
            "app/refs/Dockerfile": `FROM visible`,
        });
        expect(choreShape(dir, true).dockerfiles).toEqual([`app/refs/Dockerfile`]);
        expect(choreShape(dir).dockerfiles.toSorted()).toEqual([`app/refs/Dockerfile`, `refs/upstream/Dockerfile`]);
    });
});

describe(`workspace-root probe scope`, () => {
    test(`the UI probe does not become available from a framework manifest inside the reference shelf`, async () => {
        const dir = await scaffold({
            "refs/upstream/package.json": JSON.stringify({ dependencies: { react: `1.0.0` } }),
            "refs/upstream/Card.tsx": `export const Card = () => null`,
        });
        expect(await runProbe(probeSpec(`ui`), dir, 1000, true)).toMatchObject({ state: `unavailable` });
        expect(await runProbe(probeSpec(`ui`), dir, 1000)).toMatchObject({ state: `ok` });
    });

    test(`the UI scan skips the shelf but keeps a repository-local refs directory`, async () => {
        const dir = await scaffold({
            "package.json": JSON.stringify({ dependencies: { react: `1.0.0` } }),
            "refs/upstream/Hidden.tsx": `export const Hidden = () => null`,
            "app/refs/Visible.tsx": `export const Visible = () => null`,
        });
        const root = await runProbe(probeSpec(`ui`), dir, 1000, true);
        const repo = await runProbe(probeSpec(`ui`), dir, 1000);
        expect(root).toMatchObject({ state: `ok`, facts: { id: `ui`, scan: { components: [`app/refs/Visible.tsx`] } } });
        expect(repo).toMatchObject({
            state: `ok`,
            facts: { id: `ui`, scan: { components: [`app/refs/Visible.tsx`, `refs/upstream/Hidden.tsx`] } },
        });
    });
});
