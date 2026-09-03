import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/scaffold";
import { unstubbed } from "@intentic/testing";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import { fileTurnJournal } from "../agent/turn-journal.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import type { WakeFn } from "../automations/scheduler.js";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { Services } from "../composition.js";
import { fileThreadSessionsStore } from "../sessions/thread-sessions.js";
import { fileCiStore } from "./ci-store.js";
import { createCiPoller } from "./poller.js";
import type { FetchFn } from "./providers.js";
import { createRunsCache } from "./runs-cache.js";

/* The fallback path: a repo whose webhook could NOT be registered still wakes its `ci` automations, and the
 * first pass adopts the current picture in silence rather than replaying it. `warnings` is the whole input that
 * decides whether a repo is polled, so the fake reconciler is just that map. */

const run = (id: number, conclusion: string, branch = "main") => ({
    id,
    display_title: `run ${id}`,
    head_branch: branch,
    head_sha: `sha${id}`,
    status: "completed",
    conclusion,
    html_url: `https://github.com/acme/web/actions/runs/${id}`,
    created_at: "2026-07-29T10:00:00Z",
    updated_at: "2026-07-29T10:02:00Z",
    actor: { login: "alice" },
});

const harness = async (warned: boolean, narrow: { branch?: string } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "ci-poll-"));
    const dir = join(root, "web");
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    await defaultGit(dir, ["remote", "add", "origin", "https://github.com/acme/web.git"]);
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "config", "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "T" } });
    const automations = fileAutomationsStore(
        join(root, `${STATE_DIR}`, "config", "automations.json"),
        join(root, `${STATE_DIR}`, "records", "automation-runs.json"),
    );
    await automations.upsert({ id: "poll-ci", trigger: { kind: "listener", provider: "ci", ...narrow }, prompt: "handle ci", enabled: true });
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        automations,
        ciStore: fileCiStore(join(root, `${STATE_DIR}`, "secrets", "ci.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        ciRuns: createRunsCache(60_000),
        ciHooks: unstubbed<Services["ciHooks"]>("ciHooks", {
            warnings: () => new Map(warned ? [["web", "Pipeline webhooks are off: this sandbox has no public URL."]] : []),
        }),
        threadSessions: fileThreadSessionsStore(join(root, `${STATE_DIR}`, "records", "thread-sessions.json")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });
    const prompts: string[] = [];
    const wake: WakeFn = async function* (_services, input) {
        prompts.push(input.prompt);
        yield { kind: "done" } as never;
    };
    // The runs list, plus the failed-jobs enrichment the poller makes for a red run.
    let listed = [run(1, "success")];
    const fetchFn: FetchFn = (async (url: string) =>
        String(url).includes("/jobs")
            ? new Response(JSON.stringify({ jobs: [{ id: 1, name: "lint", conclusion: "failure" }] }))
            : new Response(JSON.stringify({ workflow_runs: listed }))) as unknown as FetchFn;
    return { services, prompts, poller: createCiPoller(services, wake, fetchFn), publish: (runs: typeof listed) => (listed = runs) };
};

test("the first pass adopts what is already there without waking anything", async () => {
    const { services, prompts, poller } = await harness(true);
    await poller.poll();
    expect(await services.ciStore.announcedRuns("web")).toEqual([1]);
    expect(prompts).toEqual([]);
});

test("a run that appears after the first pass wakes the ci automation", async () => {
    const { services, prompts, poller, publish } = await harness(true);
    // A fresh (empty) sweep, so the poller's upserts are visible through sweep() below.
    services.ciRuns.replace([]);
    await poller.poll();
    publish([run(2, "failure"), run(1, "success")]);
    await poller.poll();
    await vi.waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain("pipeline_failed");
    expect(prompts[0]).toContain("pipeline_broken");
    expect(prompts[0]).toContain(`"lint"`);
    expect(await services.ciStore.announcedRuns("web")).toEqual([2, 1]);
    // Freshened for the Pipelines view too, so an unwired sandbox is not also a blank one.
    expect(services.ciRuns.sweep()).toMatchObject([{ repo: "web", runId: 2, status: "failed", failedJobs: ["lint"] }]);
});

test("a repo whose webhook IS registered is never polled: the webhook owns it", async () => {
    const { services, prompts, poller, publish } = await harness(false);
    await poller.poll();
    publish([run(2, "failure"), run(1, "success")]);
    await poller.poll();
    expect(await services.ciStore.announcedRuns("web")).toBeUndefined();
    expect(prompts).toEqual([]);
});

test("the branch filter applies on the polled path exactly as on the webhook path", async () => {
    const { prompts, poller, publish } = await harness(true, { branch: "release" });
    await poller.poll();
    publish([run(2, "failure", "feature/x"), run(1, "success")]);
    await poller.poll();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(prompts).toEqual([]);
});
