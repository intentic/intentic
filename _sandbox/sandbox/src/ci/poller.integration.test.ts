import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/base/git";
import { unstubbed } from "@intentic/testing";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { sqliteTurnJournal } from "../store/journals/turn-journal.js";
import { conversationsDbPath, openConversationsDb } from "../store/conversations-db.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { Services } from "../composition.js";
import { fileSendersStore } from "../automations/senders-store.js";
import { fileThreadSessionsStore } from "../sessions/thread-sessions.js";
import { fileCiStore } from "./ci-store.js";
import { createCiPoller } from "./poller.js";
import type { FetchFn } from "../forge/http.js";
import { createRunsCache } from "./runs-cache.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import { drivenBy } from "../seams/turn-starter.testing.js";
import { memoryFleet } from "../conversations/registry/agents-registry.testing.js";
import { createDomainEvents } from "../seams/domain-events.js";
import type { CiFeedEvent } from "@intentic/sandbox-contract/schemas/ci";
import { subscribeCiFeed } from "../seams/ci-feed-bus.js";

// What a program reading GET /ci/feed hears (ci-feed.ts), every frame since the suite began.
const heardFeed: CiFeedEvent[] = [];
subscribeCiFeed((event) => void heardFeed.push(event));

/* The fallback path: a repo whose webhook could NOT be registered still wakes its `ci` automations. */

// The push half, recorded rather than fed to a live /events feed: subscribing for real would start the runtime
// sampler (tmux, procfs) for a fact these tests state in one line.
const { published } = { published: [] as string[] };
jest.mock("../seams/runtime-feed.js", () => ({ publishRuntimeChange: (...domains: string[]) => published.push(...domains) }));

const run = (id: number, conclusion: string | null, branch = "main", status = "completed") => ({
    id,
    display_title: `run ${id}`,
    head_branch: branch,
    head_sha: `sha${id}`,
    status,
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
    await automations.upsert({
        id: "poll-ci",
        trigger: { kind: "listener", provider: "ci", ...narrow },
        prompt: "handle ci",
        models: [{ provider: "claude", model: "claude-sonnet-4-6" }],
        enabled: true,
    });
    const services = unstubbed<Services>("services", {
        // Heard by nobody: what reacts to a wake's settled run is composition's to subscribe.
        events: createDomainEvents(() => {}),
        // Real actors under a wake's detached run (turn-runs.ts): the archived check, and the run it holds while live.
        conversations: memoryFleet().conversations,
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        capabilities,
        automations,
        // The automation inboxes (durable/inbox-store.ts) live beside the holds.
        config: unstubbed<Services["config"]>("config", { historyRoot: join(root, "history") }),
        ciStore: fileCiStore(join(root, `${STATE_DIR}`, "secrets", "ci.json")),
        // What a wake reads of the sandbox's settings: its defaults. No extension claims main lines here, so main's
        // failures reach these automations (events.ts).
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        ciRuns: createRunsCache(60_000),
        ciHooks: unstubbed<Services["ciHooks"]>("ciHooks", {
            warnings: () => new Map(warned ? [["web", { reason: "Pipeline webhooks are off: this sandbox has no public URL." }]] : []),
        }),
        threadSessions: fileThreadSessionsStore(join(root, `${STATE_DIR}`, "records", "thread-sessions.json"), () => false),
        senders: fileSendersStore(join(root, `${STATE_DIR}`, "records", "senders.json")),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {}, info: () => {} }),
    });
    const prompts: string[] = [];
    const wake: TurnStarter["stream"] = async function* (input) {
        prompts.push(input.prompt);
        yield { kind: "done" } as never;
    };
    // The runs list, plus the failed-jobs enrichment the poller makes for a failed run.
    let listed = [run(1, "success")];
    // A forge that refuses the token while `refusing.now` is set, and counts what it was asked.
    const refusing = { now: false, asked: 0 };
    const fetchFn: FetchFn = (async (url: string) => {
        refusing.asked += 1;
        if (refusing.now) {
            return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        }
        return String(url).includes("/jobs")
            ? new Response(JSON.stringify({ jobs: [{ id: 1, name: "lint", conclusion: "failure" }] }))
            : new Response(JSON.stringify({ workflow_runs: listed }));
    }) as unknown as FetchFn;
    const clock = { at: 1_000_000 };
    return {
        services,
        prompts,
        refusing,
        clock,
        // Jitter pinned to the top of its range, so a refused token's pause is each rung's whole ceiling.
        poller: createCiPoller(drivenBy(services, wake), fetchFn, 60_000, () => clock.at, () => 1),
        publish: (runs: typeof listed) => (listed = runs),
    };
};

test("the first pass adopts what is already there without waking anything", async () => {
    const { services, prompts, poller } = await harness(true);
    published.length = 0;
    await poller.poll();
    expect(await services.ciStore.announcedRuns("web")).toEqual([1]);
    expect(prompts).toEqual([]);
    // Adoption is not news: nothing moved while anyone was watching, so no board is told to re-read.
    expect(published).not.toContain("ci");
});

test("a run that appears after the first pass wakes the ci automation", async () => {
    const { services, prompts, poller, publish } = await harness(true);
    // A fresh (empty) sweep, so the poller's upserts are visible through sweep() below.
    services.ciRuns.replace([]);
    await poller.poll();
    publish([run(2, "failure"), run(1, "success")]);
    await poller.poll();
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain("pipeline_failed");
    expect(prompts[0]).toContain("pipeline_broken");
    expect(prompts[0]).toContain(`"lint"`);
    expect(await services.ciStore.announcedRuns("web")).toEqual([2, 1]);
    // Freshened for the Pipelines view too, so an unwired sandbox is not also a blank one.
    expect(services.ciRuns.sweep()).toMatchObject([{ repo: "web", runId: 2, status: "failed", failedJobs: ["lint"] }]);
    // And announced, so the board re-reads on the push a webhook would have delivered rather than on its own poll.
    expect(published).toContain("ci");
});

// Where no webhook is live, a program reading the CI feed still hears each run that ended.
test("each run the poller finds ended is a run frame on the CI feed, as the webhook's would be; the runs it adopted are not", async () => {
    const { poller, publish } = await harness(true);
    await poller.poll();
    heardFeed.length = 0;
    publish([run(3, "success"), run(2, "failure"), run(1, "success")]);
    await poller.poll();

    expect(heardFeed.map((event) => (event.kind === "run" ? `${event.run.runId}:${event.run.status}` : event.kind)).toSorted()).toEqual(["2:failed", "3:success"]);
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

// Where no job webhook is live, the poller is how a job that failed in a main line's run still going is heard: on the CI
// feed, with what the forge said of it, as the job's webhook would have put it (main's fix agent hears it there).
test("a main line's run still going puts each job it already failed on the CI feed; the first pass adopts it", async () => {
    const { poller, publish } = await harness(true);
    publish([run(3, null, "main", "in_progress"), run(4, null, "agent/x", "in_progress"), run(1, "success")]);
    await poller.poll();
    heardFeed.length = 0;
    await poller.poll();
    expect(heardFeed).toEqual([
        {
            kind: "job",
            repo: "web",
            host: "github",
            project: "acme/web",
            runId: 3,
            job: "lint",
            branch: "main",
            sha: "sha3",
            status: "failed",
            url: "https://github.com/acme/web/actions/runs/3",
            failed: { jobId: 1 },
        },
    ]);
});

// A revoked token used to be asked, and logged as refused, every pass for hours.
test("a refused token is asked again only after a pause that grows, and a new token ends the pause", async () => {
    const { services, poller, refusing, clock } = await harness(true);
    refusing.now = true;
    await poller.poll();
    expect(refusing.asked).toBe(1);
    // Within the first pause (four intervals at the top of its jitter) the repo is skipped.
    clock.at += 120_000;
    await poller.poll();
    expect(refusing.asked).toBe(1);
    clock.at += 120_000;
    await poller.poll();
    expect(refusing.asked).toBe(2);
    // The second refusal doubles the pause.
    clock.at += 240_000;
    await poller.poll();
    expect(refusing.asked).toBe(2);
    // The owner reconnects the account: the new token is asked on the very next pass.
    await services.capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "T2" } });
    refusing.now = false;
    await poller.poll();
    expect(refusing.asked).toBe(3);
    expect(await services.ciStore.announcedRuns("web")).toEqual([1]);
});
