import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import type { TurnInput } from "../seams/turn-starter.js";
import type { PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { AttemptRefused } from "../conversations/fix/fix-attempts.js";
import { idleConversation } from "../conversations/actor/conversation-state.js";
import { fleetReasons, startCiFix } from "./ci-fix.js";
import type { CiProject } from "./projects.js";

// The refusal names what the fleet did and in which jobs, not the repository steps the jobs happened to be in when it did.
test("a fleet failure is told by the sign its logs carry, with the jobs that carry it", () => {
    const docker = "##[error]Process completed with exit code 255.\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
    const failed = [
        { job: "verify-providers", id: 1, step: "Run bash _tools/scripts/ci/install-provider-clis.sh" },
        { job: "e2e-signin", id: 2, step: "Run pnpm --filter @intentic/e2e exec playwright install --with-deps chromium" },
        { job: "desktop-check", id: 3, step: "Run cargo test --manifest-path _editor/desktop-app/src-tauri/Cargo.toml" },
    ];
    expect(fleetReasons(failed, ["npm error network read ETIMEDOUT", docker, docker])).toEqual(["the runner's Docker daemon stopped answering (e2e-signin, desktop-check)"]);
    expect(fleetReasons([{ job: "test", id: 4, step: "Set up job" }], [""])).toEqual(["every failed job died in the runner's own steps (Set up job)"]);
    expect(fleetReasons([{ job: "test", id: 5, step: "Run pnpm test" }], ["FAIL src/api.test.ts"])).toEqual([]);
    // A runner that lost its connection says so only in the job's annotations, under a log that reads like any other.
    const lost = "The self-hosted runner: radarsu-worker-3 lost communication with the server.";
    expect(fleetReasons([{ job: "e2e", id: 6, annotations: [lost] }], ["FAIL src/api.test.ts"])).toEqual(["its runner lost its connection to the forge (e2e)"]);
});

// Nothing connected and nothing pinned: the fix is refused in words before any agent exists, rather than opened on a
// provider nobody connected to fail at once on the board. `agents` is left unstubbed, so reaching it would throw.
test("a fix with no provider connected is refused before an agent is created", async () => {
    const services = unstubbed<Services>("services", {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        providerReadiness: async () => Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, false])) as Awaited<ReturnType<Services["providerReadiness"]>>,
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
    });
    const project = unstubbed<CiProject>("project", { repo: "odysseus" });
    const request = { project, runId: 7, run: undefined, evidence: { failedJobs: ["test"], failedJobIds: [70], logs: "", infra: false, infraReasons: [] } };
    await expect(startCiFix(services, request)).rejects.toThrow(AttemptRefused);
    await expect(startCiFix(services, request)).rejects.toThrow(
        "No AI provider is connected to this sandbox, so there is no model to run this on. Connect one in Setup, then try again.",
    );
});

test("a retry of a turned-away CI fix sends current evidence instead of replaying its kept prompt", async () => {
    const started: TurnInput[] = [];
    const initial = idleConversation();
    const services = unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", {
            list: () => [{
                id: "fix-web-7",
                status: "error",
                failureCode: "sandbox-memory-low",
                provider: "claude",
                harness: "native",
                attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
                updatedAt: 0,
            }],
            listArchived: () => [],
            clearArchived: async () => {},
        }),
        conversations: unstubbed<Services["conversations"]>("conversations", {
            state: () => ({
                ...initial,
                resume: {
                    ...initial.resume,
                    held: {
                        reason: "door",
                        input: { conversationId: "fix-web-7", prompt: "Old evidence" },
                        ran: false,
                        recordedAt: 0,
                        fired: false,
                        tries: 0,
                    },
                },
            }),
        }),
        turns: unstubbed<Services["turns"]>("turns", {
            start: async (turn) => {
                started.push(turn);
                return { id: "run-retry", async *frames() {} };
            },
            resume: async () => { throw new Error("The kept prompt has stale evidence"); },
        }),
    });
    const outcome = await startCiFix(services, {
        project: unstubbed<CiProject>("project", { repo: "web", account: unstubbed<CiProject["account"]>("account", { provider: "github" }) }),
        runId: 7,
        run: unstubbed<PipelineRun>("run", { branch: "main", url: "https://github.com/acme/web/actions/runs/7", title: "Retry" }),
        turn: { agent: "claude", model: "test-model" },
        pressed: true,
        evidence: { failedJobs: ["new failure"], failedJobIds: [71], logs: "Error: new failure from the latest snapshot", infra: false, infraReasons: [] },
    });
    expect(outcome).toEqual({ kind: "started", conversationId: "fix-web-7", attempt: 1, continued: true });
    expect(started).toHaveLength(1);
    expect(started[0]?.prompt).toContain("Error: new failure from the latest snapshot");
});
