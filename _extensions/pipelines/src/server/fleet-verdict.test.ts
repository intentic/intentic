import type { CiFailedStep } from "@intentic/sandbox-contract/schemas/ci";
import { opt } from "./opt.js";
import { infraLog, jobVerdict, machineOf } from "./fleet-verdict.js";

/* Whose failure a failed job is, read from what GitHub Actions really serves: a jobs list entry
   (GET /repos/{o}/{r}/actions/runs/{id}/jobs) and its check run's annotations (GET /check-runs/{id}/annotations). The
   wordings are copied from runs on intentic/intentic and the runner's own source. */

// One job as the jobs list serves it, trimmed of the urls and ids no reader of ours looks at.
interface JobOver {
    readonly conclusion?: string;
    readonly runner_name?: string | null;
    readonly steps?: readonly { readonly name: string; readonly status: string; readonly conclusion: string | null; readonly number: number }[];
}
const githubJob = (over: JobOver = {}) => ({
    id: 63_210_441_207,
    run_id: 43_204_736_290,
    workflow_name: "Nightly",
    head_branch: "main",
    status: "completed",
    name: "e2e",
    conclusion: "failure",
    created_at: "2026-11-12T10:02:11Z",
    started_at: "2026-11-12T10:02:15Z",
    completed_at: "2026-11-12T10:41:52Z",
    runner_id: 41,
    runner_name: "radarsu-worker-3",
    runner_group_id: 1,
    runner_group_name: "Default",
    labels: ["self-hosted", "linux", "x64"],
    steps: [
        { name: "Set up job", status: "completed", conclusion: "success", number: 1 },
        { name: "Run actions/checkout@v4", status: "completed", conclusion: "success", number: 2 },
        { name: "Run pnpm turbo run e2e", status: "completed", conclusion: "cancelled", number: 3 },
    ],
    ...over,
});

// One check run annotation as the annotations list serves it.
const annotation = (message: string, level = "failure") => ({
    path: ".github",
    blob_href: "https://github.com/intentic/intentic/blob/5042981e/.github",
    start_line: 1,
    start_column: null,
    end_line: 1,
    end_column: null,
    annotation_level: level,
    title: "",
    message,
    raw_details: "",
});

// What the fixer is handed of the job: the core's reading of the jobs list entry with its annotations' messages (its
// forge/github-cancels.ts, tested there): the steps that failed it, and why a cancel or a timeout was a failure after all.
const failed = (job: ReturnType<typeof githubJob>, annotations: readonly ReturnType<typeof annotation>[]): CiFailedStep => {
    const messages = annotations.map(({ message }) => message);
    const steps = (job.steps ?? []).filter((step) => step.conclusion === "failure").map((step) => step.name);
    const timedOut = job.conclusion === "timed_out" || messages.some((message) => message.includes("exceeded the maximum execution time"));
    const unrun = messages.some((message) => message.includes("was not acquired by Runner"));
    return {
        job: job.name,
        id: job.id,
        ...opt("step", steps[0]),
        ...opt("steps", steps[0] === undefined ? undefined : steps),
        ...opt("reason", timedOut ? "timed_out" : unrun ? "runner_unavailable" : undefined),
        annotations: messages,
        ...opt("runner", job.runner_name ?? undefined),
    };
};

const LOST =
    "The self-hosted runner: radarsu-worker-3 lost communication with the server. Verify the machine is running and has a healthy network connection. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.";
const SHUTDOWN = "The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.";
const CANCELED = "The operation was canceled.";
const TIMED_OUT = "The job has exceeded the maximum execution time of 30m0s";
const NO_RUNNER = "The job was not acquired by Runner of type self-hosted even after multiple attempts";

test("a runner that lost its connection or was shut down under a job is the fleet's, whatever its log reads", () => {
    const lost = failed(githubJob(), [annotation(LOST), annotation(CANCELED)]);
    expect(lost).toEqual(expect.objectContaining({ job: "e2e", runner: "radarsu-worker-3", annotations: [LOST, CANCELED] }));
    expect(jobVerdict(lost, "FAIL src/a.test.ts > adds")).toEqual({ kind: "fleet", says: "its runner lost its connection to the forge" });
    expect(jobVerdict(failed(githubJob(), [annotation(SHUTDOWN)]), "")).toEqual({ kind: "fleet", says: "its runner was shut down mid-job" });
});

test("a failed job cancelled mid-run with no step of its own failing is the fleet's; with one failing it is that step's", () => {
    expect(jobVerdict(failed(githubJob(), [annotation(CANCELED)]), "")).toEqual({
        kind: "fleet",
        says: "it was cancelled mid-run with no step of its own failing",
    });
    const tests = githubJob({
        steps: [
            { name: "Set up job", status: "completed", conclusion: "success", number: 1 },
            { name: "Run pnpm turbo run test", status: "completed", conclusion: "failure", number: 2 },
        ],
    });
    expect(jobVerdict(failed(tests, [annotation(CANCELED), annotation("Process completed with exit code 1.")]), "")).toEqual({ kind: "code" });
});

test("a job past its time limit with no step of its own failing is ambiguous, cancelled or timed out", () => {
    const cancelled = failed(githubJob({ conclusion: "cancelled" }), [annotation(TIMED_OUT), annotation(CANCELED)]);
    expect(cancelled.reason).toBe("timed_out");
    expect(jobVerdict(cancelled, "")).toEqual({ kind: "ambiguous", says: "it ran past its time limit with no step of its own failing" });
    const timedOut = failed(githubJob({ conclusion: "timed_out" }), []);
    expect(timedOut.reason).toBe("timed_out");
    expect(jobVerdict(timedOut, "")).toEqual({ kind: "ambiguous", says: "it ran past its time limit with no step of its own failing" });
});

test("a job no runner took is the fleet's", () => {
    expect(jobVerdict(failed(githubJob({ conclusion: "cancelled", steps: [] }), [annotation(NO_RUNNER)]), "")).toEqual({ kind: "fleet", says: "no runner took it" });
});

test("a test that fails is the code's, a runner-owned step, a GitLab reason and a runner's log line the fleet's", () => {
    const tests = githubJob({
        runner_name: null,
        steps: [{ name: "Run pnpm turbo run test", status: "completed", conclusion: "failure", number: 2 }],
    });
    const step = failed(tests, [annotation("Process completed with exit code 1.")]);
    expect(step.runner).toBeUndefined();
    expect(jobVerdict(step, "FAIL src/api.test.ts\n  Error: connect ECONNREFUSED 127.0.0.1:4317")).toEqual({ kind: "code" });
    expect(jobVerdict({ step: "Set up job", steps: ["Set up job"] }, "")).toEqual({ kind: "fleet", says: `it died in the runner's own step "Set up job"` });
    expect(jobVerdict({ reason: "runner_system_failure" }, "")).toEqual({ kind: "fleet", says: "its runner failed (runner_system_failure)" });
    expect(jobVerdict({ step: "Run tests" }, "write /tmp/x: no space left on device")).toEqual({ kind: "fleet", says: "the runner's disk is full" });
    // Unread annotations are no evidence either way.
    expect(jobVerdict({ step: "Run tests" }, "")).toEqual({ kind: "code" });
});

test("the runner's own log lines read as the fleet, a failing test's words never do", () => {
    expect(infraLog("ERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")).toBe(true);
    expect(infraLog("write /tmp/x: no space left on device")).toBe(true);
    expect(infraLog("Put https://ghcr.io/v2/x/blobs/uploads: net/http: timeout awaiting response headers")).toBe(true);
    expect(infraLog("The self-hosted runner: worker-3 lost communication with the server.")).toBe(true);
    expect(infraLog("FAIL src/api.test.ts > retries\n  Error: connect ECONNREFUSED 127.0.0.1:4317")).toBe(false);
    expect(infraLog("expected status 200, received 503 Service Unavailable")).toBe(false);
});

test("the machine a self-hosted runner ran on is read off the job log's first lines", () => {
    const head = "Current runner version: '2.329.0'\nRunner name: 'radarsu-worker-3'\nRunner group name: 'Default'\nMachine name: 'omen'\n##[group]GITHUB_TOKEN Permissions";
    expect(machineOf(head)).toBe("omen");
    expect(machineOf("(log unavailable: 404)")).toBeUndefined();
});
