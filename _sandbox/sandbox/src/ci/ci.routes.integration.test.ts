import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/base/git";
import type { CiFailure } from "@intentic/sandbox-contract/schemas/ci";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import { waitFor } from "@intentic/testing/bun";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { writeExtensionEnablement } from "../capabilities/extension-inventory/extension-enablement.js";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { extensionThatStarted } from "../extensions/runtime/extension-conversations.js";
import { readAllExtensionSettings } from "../extensions/extension-settings.js";
import { fileCiStore } from "./ci-store.js";
import { createCiRoutes } from "./ci.routes.js";
import { mainLinesClaimed } from "./main-line-claims.js";
import type { FetchFn } from "../forge/http.js";
import { handOverRepair } from "./repair-hand-over.js";
import { createRunsCache } from "./runs-cache.js";

/* CI ingestion's routes: what the forges report, and the forge reads the pipelines extension's backend asks of the
   core's clients. (2026-11-26) What a Fix press starts, and main's failures on the runs list, are that backend's own
   (_extensions/pipelines/src/server), and tested there. */

const context: OrpcContext = { headers: new Headers(), method: "GET", url: "/ci/runs" };

const RUN_ID = 41;

const JOBS = { jobs: [{ id: 7, name: "onboarding", conclusion: "failure", status: "completed", html_url: null, steps: [{ name: "Run onboarding tier", conclusion: "failure" }] }] };

const harness = async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-routes-"));
    const dir = join(root, "web");
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    await defaultGit(dir, ["remote", "add", "origin", "https://github.com/acme/web.git"]);
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "config", "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "T" } });
    const ciRuns = createRunsCache(60_000);
    ciRuns.replace([
        {
            repo: "web",
            host: "github",
            project: "acme/web",
            runId: RUN_ID,
            title: "build broke",
            branch: "main",
            sha: "sha41",
            status: "failed",
            url: `https://github.com/acme/web/actions/runs/${RUN_ID}`,
            createdAt: 1,
        },
    ]);
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        ciRuns,
        ciStore: fileCiStore(join(root, STATE_DIR, "secrets", "ci.json")),
        ciHooks: unstubbed<Services["ciHooks"]>("ciHooks", { warnings: () => new Map() }),
        // Loopback: no identities, so the caller is the owner.
        auth: undefined,
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {} }),
    });
    const fetchFn: FetchFn = (async (url: string) =>
        String(url).includes("/logs") ? new Response("Error: P1001: Can't reach database server") : new Response(JSON.stringify(JOBS))) as unknown as FetchFn;
    return { routes: createCiRoutes(services, fetchFn), services, root };
};

test("the runs list answers what the forges report, and leaves main's failures to the extension that keeps them", async () => {
    const { routes } = await harness();
    const answer = await call(routes.runs, undefined, { context });
    expect(answer.runs.map(({ runId }) => runId)).toEqual([RUN_ID]);
    expect(answer.repos.map(({ repo }) => repo)).toEqual(["web"]);
    expect(Object.keys(answer)).toEqual(["repos", "runs"]);
});

// What main's fix agent reads of a failure, asked of the forge through the core's client: its failed jobs with the steps
// that failed them, a job's whole log, and which branch is the repository's main line.
test("the forge reads answer a run's failed jobs, a job's log and each repository's main line", async () => {
    const { routes } = await harness();
    expect(await call(routes.failedSteps, { repo: "web", runId: RUN_ID }, { context })).toEqual({
        steps: [{ job: "onboarding", id: 7, step: "Run onboarding tier", steps: ["Run onboarding tier"] }],
    });
    expect((await call(routes.jobLog, { repo: "web", jobId: 7 }, { context })).log).toContain("P1001");
    // Nothing has said which branch is the default yet: both usual names stand in.
    expect(await call(routes.mainLines, undefined, { context })).toEqual({
        lines: [{ repo: "web", host: "github", project: "acme/web", branches: ["main", "master"], named: false, concluded: [] }],
    });
    await expect(call(routes.failedSteps, { repo: "nowhere", runId: RUN_ID }, { context })).rejects.toThrow("no CI project mapped");
});

// The claim and the hand-over are an extension's alone: a person's or a program's request carries no extension token.
test("claiming main lines and taking main's repair over refuse a caller that is no extension", async () => {
    const { routes } = await harness();
    await expect(call(routes.claimMainLines, { claimed: true }, { context })).rejects.toThrow("only an extension's own token");
    await expect(call(routes.handOverRepair, undefined, { context })).rejects.toThrow("only an extension's own token");
});

// An extension switched on, built in under `extensionsDir`, declaring the setting the hand-over carries the owner's
// choice into.
const PIPELINES_MANIFEST = {
    publisher: "intentic",
    name: "pipelines",
    version: "1.0.0",
    engines: { intentic: "^2.56.0" },
    contributes: { settings: [{ key: "autoRepair", title: "Repair main's CI", type: "boolean", default: true }] },
};

const extensionHost = async (root: string, enabled: boolean) => {
    const extensionsDir = join(root, "builtin");
    await mkdir(join(extensionsDir, "pipelines"), { recursive: true });
    await writeFile(join(extensionsDir, "pipelines", "intentic-extension.json"), JSON.stringify(PIPELINES_MANIFEST));
    const capabilities = fileCapabilitiesStore(join(root, STATE_DIR, "config", "capabilities.json"));
    await writeExtensionEnablement(root, "intentic.pipelines", enabled);
    return {
        workspace: { root },
        files: { read: (path: string) => readFile(path, "utf8").catch(() => undefined) },
        capabilities,
        config: { extensionsDir, historyRoot: join(root, "history") },
    };
};

// (2026-11-26) While a switched-on extension claims main lines, a main line's failure is its fix agent's alone; a claim
// whose extension is off holds nothing.
test("a claim on main lines holds only while its extension is switched on", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-claims-"));
    const ciStore = fileCiStore(join(root, "ci.json"));
    const on = await extensionHost(root, true);
    expect(await mainLinesClaimed({ ...on, ciStore })).toBe(false);
    await ciStore.claimMainLines("intentic.pipelines", true, 1);
    expect(await mainLinesClaimed({ ...on, ciStore })).toBe(true);
    // Switched off, its claim stands in the store and holds nothing.
    const off = await extensionHost(root, false);
    expect(await mainLinesClaimed({ ...off, ciStore })).toBe(false);
    await ciStore.claimMainLines("intentic.pipelines", false, 2);
    expect(await mainLinesClaimed({ ...on, ciStore })).toBe(false);
});

const FAILURE: CiFailure = {
    since: 1,
    findings: [{ id: "f", source: "CI", text: "onboarding" }],
    decisions: [{ kind: "fix-up", conversationId: "ci-fix-web-40", at: 1 }],
    firstRunId: 40,
    runId: RUN_ID,
    count: 2,
    workflows: { CI: RUN_ID },
    spans: {},
    heard: ["40/6", "41/7"],
    turns: 2,
    changed: false,
};

// The update that moved main's fix agent out: its streak, with the turns its agent was given, reaches the extension, the
// agent's runs become the extension's to hear, and an owner who had switched repairs off has them off there too.
test("the hand-over gives the extension main's streak, its fix agents' runs and the owner's switch, once", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-hand-over-"));
    const ciPath = join(root, "ci.json");
    await writeFile(ciPath, JSON.stringify({ secret: "s", conclusions: {}, failures: { "web\nmain": FAILURE }, ownerSteps: { "ci-fix-web-39": { step: "Fill it.", at: 3 } } }));
    const host = await extensionHost(root, true);
    const services = unstubbed<Services>("services", {
        ...host,
        // SAFETY: the inventory reads files only through `read`, which is all an extension host is handed here.
        files: host.files as Services["files"],
        config: unstubbed<Services["config"]>("config", host.config),
        ciStore: fileCiStore(ciPath),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({ autoRepair: false }) }),
        extensionSecretVault: unstubbed<Services["extensionSecretVault"]>("extensionSecretVault", {
            all: async () => ({}),
            get: async () => ({}),
            set: async () => {},
        }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {} }),
    });
    const handed = await handOverRepair(services, "intentic.pipelines", 5);
    expect(handed).toEqual({ failures: { "web\nmain": FAILURE }, passes: {}, fleetReruns: {}, ownerSteps: { "ci-fix-web-39": { step: "Fill it.", at: 3 } }, autoRepair: false });
    expect(await extensionThatStarted(host.config.historyRoot, "ci-fix-web-40")).toBe("intentic.pipelines");
    expect(await extensionThatStarted(host.config.historyRoot, "ci-fix-web-39")).toBe("intentic.pipelines");
    expect((await readAllExtensionSettings(root, services.extensionSecretVault))["intentic.pipelines"]).toEqual({ autoRepair: false });
    // Handed over: a second ask, a later boot's, finds nothing to give.
    expect(await handOverRepair(services, "intentic.pipelines", 6)).toEqual({ failures: {}, passes: {}, fleetReruns: {}, ownerSteps: {} });
    await waitFor(async () => expect(JSON.parse(await readFile(ciPath, "utf8")).failures).toBeUndefined());
});

// Every open Pipelines board re-lists a stale picture; boards asking at once used to ask the vendor once each. They share
// one call per project now, joined only while it began within the cache's TTL: a call older than that is not joined, and
// once the shared call has landed, the picture it filled is what the next board reads.
test("boards that find the runs stale together share one vendor call per project, but never one older than the cache's TTL", async () => {
    const { services } = await harness();
    let lists = 0;
    const releases: (() => void)[] = [];
    const fetchFn: FetchFn = async (input) => {
        if (!(input instanceof Request ? input.url : String(input)).includes("/actions/runs?")) {
            return new Response(JSON.stringify(JOBS));
        }
        lists += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return new Response(JSON.stringify({ workflow_runs: [] }));
    };
    // Never swept, so stale: every board below backfills.
    const routes = createCiRoutes({ ...services, ciRuns: createRunsCache(20_000) }, fetchFn);

    const boards = [call(routes.runs, undefined, { context }), call(routes.runs, undefined, { context }), call(routes.runs, undefined, { context })];
    await waitFor(() => expect(lists).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lists).toBe(1);
    releases.shift()?.();
    await Promise.all(boards);
    // Landed and within the TTL: served from the picture, no call at all.
    await call(routes.runs, undefined, { context });
    expect(lists).toBe(1);

    jest.useFakeTimers();
    try {
        jest.setSystemTime(Date.now() + 30_000);
        const slow = call(routes.runs, undefined, { context });
        await waitFor(() => expect(lists).toBe(2));
        // The call under way began longer ago than the TTL allows a picture to be: a board now asks the vendor itself.
        jest.setSystemTime(Date.now() + 20_001);
        const late = call(routes.runs, undefined, { context });
        await waitFor(() => expect(lists).toBe(3));
        for (const release of releases.splice(0)) {
            release();
        }
        await Promise.all([slow, late]);
    } finally {
        jest.useRealTimers();
    }
});
