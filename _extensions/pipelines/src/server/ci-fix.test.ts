import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { unstubbed } from "@intentic/testing";
import { fleetReasons, startCiFix } from "./ci-fix.js";
import type { AgentRun, PipelinesDaemon } from "./daemon.js";
import type { Repair } from "./repair.js";

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

// A fix attempt turned away at the daemon's door (its turn held, never run) is tried again with the failure as it stands
// now, the whole prompt and not a replay of what was kept. (2026-11-26) Which model a fix opens on is the `pipeline-fix`
// job's, decided by the daemon at POST /agent; a sandbox with no provider to run it says so there, in its own words.
test("a retry of a turned-away CI fix sends current evidence, as the job's turn", async () => {
    const said: AgentRun[] = [];
    const turnedAway: AgentSummary = {
        id: "fix-web-7",
        status: "error",
        failureCode: "sandbox-memory-low",
        provider: "claude",
        harness: "native",
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        updatedAt: 0,
    };
    // Only what a fix attempt asks of the daemon is answered; anything else throws.
    const daemon = unstubbed<PipelinesDaemon>("daemon", {
        roster: async () => [turnedAway],
        archivedIds: async () => [],
        say: async (turn: AgentRun) => {
            said.push(turn);
            return { delivered: "started" as const, run: "run-retry" };
        },
    });
    // The fix reads the daemon and nothing else of the repair when the run is handed in.
    const repair = unstubbed<Repair>("repair", { daemon });
    const outcome = await startCiFix(repair, {
        project: { repo: "web", host: "github", project: "acme/web", branches: ["main"], named: true, concluded: [] },
        runId: 7,
        run: unstubbed<PipelineRun>("run", { branch: "main", url: "https://github.com/acme/web/actions/runs/7", title: "Retry" }),
        turn: { agent: "claude", model: "test-model" },
        evidence: { failedJobs: ["new failure"], failedJobIds: [71], logs: "Error: new failure from the latest snapshot", infra: false, infraReasons: [] },
    });
    expect(outcome).toEqual({ kind: "started", conversationId: "fix-web-7", attempt: 1, continued: true });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ conversationId: "fix-web-7", isolated: true, job: "pipeline-fix", agent: "claude", model: "test-model" });
    expect(said[0]?.prompt).toContain("Error: new failure from the latest snapshot");
});
