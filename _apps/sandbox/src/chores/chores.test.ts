import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeSpec } from "@intentic/sandbox-contract/chores";
import type { ChoreLedgerEntry, ProbeResult } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, test } from "vitest";
import { choreShape, packageSignals } from "./chore-signals.js";
import { fileChoresStore, isStale } from "./chores-store.js";
import { runProbe } from "./probe-runner.js";

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

/* The runner's contract is that EVERY outcome is a recorded result — the panel showing "jscpd failed: out of
 * memory" is strictly better than a probe that vanishes and leaves a chore reading "not measured yet" forever.
 * The three states are tested against real commands rather than mocks, because the thing being verified is
 * exactly the shell behaviour: what an absent tool does, what a non-zero exit does, and what unrecognisable
 * output does. */
describe(`runProbe`, () => {
    // A spec whose shape is real but whose commands are trivial, so the test measures the runner rather than pnpm.
    const fakeSpec = (over: Partial<ReturnType<typeof probeSpec>>) => ({ ...probeSpec(`outdated`), ...over });

    test(`a tool this repository does not have is unavailable — not a clean result`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const result = await runProbe(fakeSpec({ available: `exit 1` }), dir, 1000);
        expect(result).toMatchObject({ id: `outdated`, state: `unavailable`, ranAt: 1000 });
        expect(result.facts).toBeUndefined();
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
        const result = await runProbe(fakeSpec({ available: `true`, command: `echo "not json at all"` }), dir, 1000);
        expect(result.state).toBe(`failed`);
        expect(result.reason).toContain(`could not read the tool's output`);
    });

    test(`a command that exits non-zero WITH usable output still succeeds — pnpm exits 1 when it has findings`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const result = await runProbe(
            fakeSpec({ available: `true`, command: `echo '{"vue":{"current":"1.0.0","latest":"2.0.0"}}'; exit 0` }),
            dir,
            1000,
        );
        expect(result.state).toBe(`ok`);
        expect(result.facts).toEqual({ id: `outdated`, packages: [{ name: `vue`, current: `1.0.0`, latest: `2.0.0`, kind: `major`, section: `dependencies` }] });
    });

    test(`a command that hangs is killed and says so rather than holding the lane forever`, async () => {
        const dir = await scaffold({ "package.json": `{}` });
        const result = await runProbe(fakeSpec({ available: `true`, command: `sleep 5`, timeoutMs: 200 }), dir, 1000);
        expect(result.state).toBe(`failed`);
        expect(result.reason).toContain(`timed out`);
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

    // A deleted clone's measurements must not outlive it — they would render as a repository nobody can open.
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
});

describe(`package signals`, () => {
    test(`read engines and dependency names, and whether the package has a document`, async () => {
        const dir = await scaffold({
            "pnpm-workspace.yaml": `packages:\n  - "_libs/*"\n`,
            "_libs/one/package.json": JSON.stringify({ name: `@x/one`, engines: { node: `>=22` }, dependencies: { zod: `^4` }, devDependencies: { vitest: `^2` } }),
            "_libs/two/package.json": JSON.stringify({ name: `@x/two` }),
            "docs/architecture/_libs/one/doc.md": `# one`,
        });
        expect(packageSignals(dir)).toEqual([
            { dir: `_libs/one`, name: `@x/one`, engines: { node: `>=22` }, dependencies: [`zod`], devDependencies: [`vitest`], documented: true },
            { dir: `_libs/two`, name: `@x/two`, dependencies: [], devDependencies: [], documented: false },
        ]);
    });

    /* A repo that is not a pnpm workspace has no packages, and that is a true answer rather than a gap — the root
     * manifest is deliberately NOT folded in as a pseudo-package, which would make every ordinary repo report
     * exactly one undocumented "package": a finding about our modelling rather than about the code. */
    test(`a repo that is not a workspace reports no packages at all`, async () => {
        const dir = await scaffold({ "package.json": JSON.stringify({ name: `plain` }) });
        expect(packageSignals(dir)).toEqual([]);
    });
});

/* WHAT THE REPOSITORY IS MADE OF — the facts the applicability gates read. Presence of a FILE, deliberately:
 * checkable, cheap, and not arguable, which is the same evidence-over-identity rule extension activation follows.
 * Every case below decides whether a whole chore appears, so a false negative here is a chore that silently never
 * shows up and a false positive is one that can never be acted on. */
describe(`repo shape`, () => {
    test(`finds documents, Dockerfiles by either convention, workflows and the lockfile`, async () => {
        const dir = await scaffold({
            "package.json": `{}`,
            "pnpm-lock.yaml": ``,
            "Dockerfile": `FROM node`,
            "_apps/web/web.Dockerfile": `FROM nginx`,
            ".github/workflows/ci.yml": `on: push`,
            ".github/workflows/release.yaml": `on: tag`,
            "docs/architecture/repo.md": `# repo`,
            "docs/architecture/_libs/one/doc.md": `# one`,
        });
        const found = choreShape(dir);
        expect(found.lockfile).toBe(true);
        expect(found.packageManifest).toBe(true);
        expect(found.dockerfiles.toSorted()).toEqual([`Dockerfile`, `_apps/web/web.Dockerfile`]);
        expect(found.ci.toSorted()).toEqual([`.github/workflows/ci.yml`, `.github/workflows/release.yaml`]);
        expect(found.docs).toHaveLength(2);
    });

    test(`an empty repository rules everything out rather than guessing`, async () => {
        const found = choreShape(await scaffold({ "README.md": `# hi` }));
        expect(found).toEqual({ docs: [], dockerfiles: [], ci: [], lockfile: false, packageManifest: false });
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
