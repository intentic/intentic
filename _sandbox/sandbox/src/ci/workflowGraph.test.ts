import type { PipelineStatus } from "@intentic/sandbox-contract";
import { type ReportedJob, remoteWorkflow, resolveRun, type RunJob, workflowCalls } from "./workflowGraph.js";

// Pins resolveRun's job-id-to-display-name matching: needs uses job IDs, the jobs API reports display names, and
// matrices/reusable workflows diverge further. Then that the graph is GitHub's: every declared job drawn, in its order.

const ran = (names: readonly string[], status: PipelineStatus = "success"): ReportedJob[] => names.map((name) => ({ name, status }));

// Name -> what it waited on, for the jobs the graph resolved; a reported job nothing declares maps to undefined.
const resolveNeeds = (yaml: string, names: readonly string[], called?: ReadonlyMap<string, string>): Map<string, readonly string[] | undefined> =>
    new Map((resolveRun(yaml, ran(names), called) ?? []).map((job) => [job.name, job.needs]));

test("plain jobs: needs in both the string and the list spelling", () => {
    const yaml = `
jobs:
  changes: {}
  ci-base:
    needs: changes
  images:
    needs: [ci-base, changes]
`;
    expect(resolveNeeds(yaml, ["changes", "ci-base", "images"])).toEqual(
        new Map([
            ["changes", []],
            ["ci-base", ["changes"]],
            ["images", ["ci-base", "changes"]],
        ]),
    );
});

test("a matched job with no needs is a ROOT, not an unknown", () => {
    const resolved = resolveNeeds(`jobs:\n  preflight: {}\n`, ["preflight"]);
    expect(resolved.get("preflight")).toEqual([]);
    expect(resolved.has("preflight")).toBe(true);
});

test("a reusable workflow call: one declared job, several reported jobs, all of them dependents", () => {
    const yaml = `
jobs:
  preflight: {}
  verify-site:
    needs: preflight
    uses: ./.github/workflows/verify-site.yml
  release:
    needs: verify-site
`;
    // verify-site.yml is not passed in; its jobs are only known by name.
    const resolved = resolveNeeds(yaml, ["preflight", "verify-site / verify", "verify-site / e2e-hermetic", "release"]);
    expect(resolved.get("verify-site / verify")).toEqual(["preflight"]);
    expect(resolved.get("verify-site / e2e-hermetic")).toEqual(["preflight"]);
    expect(resolved.get("release")).toEqual(["verify-site / verify", "verify-site / e2e-hermetic"]);
});

test("a called file that IS in front of us is drawn as the chain it declares, not as siblings", () => {
    const ci = `
jobs:
  preflight: {}
  release:
    needs: preflight
    uses: ./.github/workflows/release.yml
  announce:
    needs: release
`;
    const release = `
on:
  workflow_call:
jobs:
  plan: {}
  build:
    needs: plan
  publish:
    needs: [plan, build]
`;
    const resolved = resolveNeeds(
        ci,
        ["preflight", "release / plan", "release / build", "release / publish", "announce"],
        new Map([[".github/workflows/release.yml", release]]),
    );
    // A root of the called file hangs where the calling job hung.
    expect(resolved.get("release / plan")).toEqual(["preflight"]);
    expect(resolved.get("release / build")).toEqual(["release / plan"]);
    expect(resolved.get("release / publish")).toEqual(["release / plan", "release / build"]);
    // Waiting for the call means waiting for the job that finishes it, not for every job it contains.
    expect(resolved.get("announce")).toEqual(["release / publish"]);
});

test("a called file that calls another is followed to the bottom", () => {
    const ci = `jobs:\n  release:\n    uses: ./.github/workflows/release.yml\n`;
    const release = `
jobs:
  plan: {}
  verify:
    needs: plan
    uses: ./.github/workflows/smoke.yml
  publish:
    needs: verify
`;
    const smoke = `jobs:\n  smoke: {}\n`;
    const resolved = resolveNeeds(
        ci,
        ["release / plan", "release / verify / smoke", "release / publish"],
        new Map([
            [".github/workflows/release.yml", release],
            [".github/workflows/smoke.yml", smoke],
        ]),
    );
    expect(resolved.get("release / verify / smoke")).toEqual(["release / plan"]);
    expect(resolved.get("release / publish")).toEqual(["release / verify / smoke"]);
});

test("a ring of calls stops instead of following itself for ever", () => {
    const first = `jobs:\n  loop:\n    uses: ./.github/workflows/second.yml\n`;
    const second = `jobs:\n  back:\n    uses: ./.github/workflows/first.yml\n`;
    const sources = new Map([
        [".github/workflows/second.yml", second],
        [".github/workflows/first.yml", first],
    ]);
    // Stops on the second repeat; the unfollowed innermost call is still matchable, like a call into another repo.
    expect(resolveNeeds(first, ["loop / back / loop"], sources).get("loop / back / loop")).toEqual([]);
});

test("workflowCalls names every called workflow file once, and no action", () => {
    const yaml = `
jobs:
  here:
    uses: ./.github/workflows/verify.yml
  elsewhere:
    uses: other/repo/.github/workflows/verify.yml@v1
  steps-only:
    steps:
      - uses: actions/checkout@v4
  again:
    uses: ./.github/workflows/verify.yml
`;
    expect(workflowCalls(yaml)).toEqual([".github/workflows/verify.yml", "other/repo/.github/workflows/verify.yml@v1"]);
    expect(remoteWorkflow("other/repo/.github/workflows/verify.yml@v1")).toEqual({
        repo: "other/repo",
        path: ".github/workflows/verify.yml",
        ref: "v1",
    });
    expect(remoteWorkflow(".github/workflows/verify.yml")).toBeUndefined();
});

test("another repository's workflow is followed like this one's, and a `./` call inside it stays in that repository", () => {
    const ci = `jobs:\n  review:\n    uses: org/shared/.github/workflows/review.yml@abc123\n  ship:\n    needs: review\n`;
    const review = `jobs:\n  prepare: {}\n  report:\n    needs: prepare\n    uses: ./.github/workflows/report.yml\n`;
    expect(workflowCalls(review, "org/shared/.github/workflows/review.yml@abc123")).toEqual(["org/shared/.github/workflows/report.yml@abc123"]);
    const called = new Map([
        ["org/shared/.github/workflows/review.yml@abc123", review],
        ["org/shared/.github/workflows/report.yml@abc123", `jobs:\n  post: {}\n`],
    ]);
    expect(shape(resolveRun(ci, ran(["review / prepare", "review / report / post", "ship"]), called))).toEqual([
        ["review / prepare", "success", []],
        ["review / report / post", "success", ["review / prepare"]],
        ["ship", "success", ["review / report / post"]],
    ]);
});

test("a matrix, one declared job, one reported job per leg", () => {
    const yaml = `
jobs:
  build: {}
  e2e:
    needs: build
  report:
    needs: e2e
`;
    const resolved = resolveNeeds(yaml, ["build", "e2e (chromium)", "e2e (firefox)", "report"]);
    expect(resolved.get("e2e (chromium)")).toEqual(["build"]);
    expect(resolved.get("report")).toEqual(["e2e (chromium)", "e2e (firefox)"]);
});

test("the LONGEST label wins: `verify` must not claim `verify-core / verify`", () => {
    // A plain startsWith would let `verify` swallow `verify-core`'s jobs as its own.
    const yaml = `
jobs:
  verify: {}
  verify-core:
    needs: verify
    uses: ./.github/workflows/verify.yml
`;
    expect(resolveNeeds(yaml, ["verify", "verify-core / verify"])).toEqual(
        new Map([
            ["verify", []],
            ["verify-core / verify", ["verify"]],
        ]),
    );
});

test("an explicit `name:` is matched, and an expression name falls back to the id", () => {
    const yaml = `
jobs:
  lint:
    name: Lint everything
  legs:
    name: leg \${{ matrix.os }}
    needs: lint
`;
    const resolved = resolveNeeds(yaml, ["Lint everything", "legs (ubuntu)"]);
    expect(resolved.get("Lint everything")).toEqual([]);
    expect(resolved.get("legs (ubuntu)")).toEqual(["Lint everything"]);
});

test("a declared job the run never reported is drawn as never run, and stays wired", () => {
    const yaml = `
jobs:
  build: {}
  slow-path:
    if: false
  ship:
    needs: [build, slow-path]
`;
    const jobs = resolveRun(yaml, ran(["build", "ship"])) ?? [];
    // After every reported job, as GitHub lists a card's rows: what the run reported in workflow order, then the rest.
    expect(jobs.map((job) => [job.name, job.status, job.reported])).toEqual([
        ["build", "success", 0],
        ["ship", "success", 1],
        ["slow-path", "skipped", undefined],
    ]);
    expect(jobs.find((job) => job.name === "ship")?.needs).toEqual(["build", "slow-path"]);
});

test("while the run is in flight, a job not created yet is drawn as waiting", () => {
    const yaml = `jobs:\n  build: {}\n  ship:\n    needs: build\n`;
    const jobs = resolveRun(yaml, ran(["build"], "running")) ?? [];
    expect(jobs.map((job) => [job.name, job.status, job.needs])).toEqual([
        ["build", "running", []],
        ["ship", "queued", ["build"]],
    ]);
});

test("an unreported job named by nothing but an expression is not guessed at: its edges drop instead", () => {
    const yaml = `
jobs:
  build: {}
  legs:
    name: \${{ matrix.os }}
    needs: build
  ship:
    needs: [build, legs]
`;
    expect(resolveNeeds(yaml, ["build", "ship"])).toEqual(
        new Map([
            ["build", []],
            ["ship", ["build"]],
        ]),
    );
});

test("a reported name nothing declares is drawn last and unwired: no invented parent", () => {
    const jobs = resolveRun(`jobs:\n  build: {}\n`, ran(["something-else-entirely", "build"])) ?? [];
    // Drawn last, with no needs at all rather than an empty list, which would claim it is a root.
    expect(jobs.map((job) => [job.name, job.needs])).toEqual([
        ["build", []],
        ["something-else-entirely", undefined],
    ]);
});

test("anything that is not a readable workflow resolves to nothing at all", () => {
    expect(resolveRun(`name: ci\non: push\n`, ran(["build"]))).toBeUndefined();
    expect(resolveRun(`just a string`, ran(["build"]))).toBeUndefined();
    expect(resolveRun(``, ran(["build"]))).toBeUndefined();
});

// The shape intentic's own CI has: a skipped call is reported as ONE job under the caller's name, and GitHub draws the
// called file's jobs in its place.
const ci = `
jobs:
  preflight: {}
  release:
    needs: preflight
    uses: ./.github/workflows/release.yml
  images:
    needs: [release, preflight]
`;
const release = `
on:
  workflow_call:
jobs:
  plan: {}
  windows-build:
    needs: plan
  sandbox-arm64:
    needs: plan
  images-amd64:
    needs: plan
  publish:
    needs: [plan, windows-build, sandbox-arm64, images-amd64]
`;
const releaseFile = new Map([[".github/workflows/release.yml", release]]);
const shape = (jobs: readonly RunJob[] | undefined): (readonly [string, PipelineStatus, readonly string[] | undefined])[] =>
    (jobs ?? []).map((job) => [job.name, job.status, job.needs] as const);

test("a skipped call reported as one job is drawn as the jobs it calls, in its place", () => {
    const reported: ReportedJob[] = [
        { name: "preflight", status: "failed" },
        { name: "release", status: "skipped" },
        { name: "images", status: "skipped" },
    ];
    const jobs = resolveRun(ci, reported, releaseFile);
    expect(shape(jobs)).toEqual([
        ["preflight", "failed", []],
        // Its own declared needs first, then what finishes the call it waits on.
        ["images", "skipped", ["preflight", "release / publish"]],
        // Jobs the run never reported sort by name, as GitHub lists them.
        ["release / images-amd64", "skipped", ["release / plan"]],
        ["release / plan", "skipped", ["preflight"]],
        ["release / publish", "skipped", ["release / plan", "release / windows-build", "release / sandbox-arm64", "release / images-amd64"]],
        ["release / sandbox-arm64", "skipped", ["release / plan"]],
        ["release / windows-build", "skipped", ["release / plan"]],
    ]);
    // The caller's own job page stands in for each of them.
    expect(jobs?.find((job) => job.name === "release / plan")).toMatchObject({ standIn: 1 });
    expect(jobs?.some((job) => job.name === "release")).toBe(false);
});

test("a call that failed as one job stays that job: its own report is what to read", () => {
    const reported: ReportedJob[] = [
        { name: "preflight", status: "success" },
        { name: "release", status: "failed" },
        { name: "images", status: "skipped" },
    ];
    expect(shape(resolveRun(ci, reported, releaseFile))).toEqual([
        ["preflight", "success", []],
        ["release", "failed", ["preflight"]],
        ["images", "skipped", ["preflight", "release"]],
    ]);
});

test("a call reached through the newer `$/` spelling is followed like `./`", () => {
    const yaml = `jobs:\n  plan:\n    uses: $/.github/workflows/plan.yml\n`;
    expect(workflowCalls(yaml)).toEqual([".github/workflows/plan.yml"]);
    const jobs = resolveRun(yaml, ran(["plan / plan"]), new Map([[".github/workflows/plan.yml", `jobs:\n  plan: {}\n`]]));
    expect(shape(jobs)).toEqual([["plan / plan", "success", []]]);
});

test("top-level jobs keep their declared order, whatever order the run reported them in", () => {
    const yaml = `jobs:\n  quick: {}\n  migrations: {}\n  e2e-billing: {}\n`;
    expect((resolveRun(yaml, ran(["e2e-billing", "quick", "migrations"])) ?? []).map((job) => job.name)).toEqual([
        "quick",
        "migrations",
        "e2e-billing",
    ]);
});

test("a matrix is marked on every leg, and a matrix of calls stays the caller's matrix", () => {
    const yaml = `
jobs:
  build: {}
  e2e:
    needs: build
    strategy:
      matrix:
        browser: [chromium, firefox]
  test:
    needs: build
    strategy:
      matrix:
        shard: [a, b]
    uses: ./.github/workflows/test.yml
`;
    expect(workflowCalls(yaml)).toEqual([]);
    const jobs = resolveRun(yaml, ran(["build", "e2e (chromium)", "e2e (firefox)", "test (a) / unit", "test (b) / unit"])) ?? [];
    expect(jobs.map((job) => [job.name, job.matrix, job.needs])).toEqual([
        ["build", undefined, []],
        ["e2e (chromium)", "e2e", ["build"]],
        ["e2e (firefox)", "e2e", ["build"]],
        ["test (a) / unit", "test", ["build"]],
        ["test (b) / unit", "test", ["build"]],
    ]);
});

test("a name written as an expression matches what it evaluated to, and the expression a skipped matrix reports", () => {
    const yaml = `
jobs:
  changes: {}
  build:
    name: "Build: \${{ matrix.os }}"
    needs: changes
    strategy:
      matrix:
        os: [ubuntu-latest, windows-2025]
  test:
    name: "Test (\${{ matrix.suite }}): \${{ matrix.os }}"
    needs: build
    strategy:
      matrix:
        os: [ubuntu-latest]
`;
    const jobs =
        resolveRun(yaml, ran(["changes", "Build: ubuntu-latest", "Build: windows-2025", "Test (${{ matrix.suite }}): ${{ matrix.os }}"])) ?? [];
    expect(jobs.map((job) => [job.name, job.matrix, job.needs])).toEqual([
        ["changes", undefined, []],
        // The matrix is known by its id: its name has no one value.
        ["Build: ubuntu-latest", "build", ["changes"]],
        ["Build: windows-2025", "build", ["changes"]],
        ["Test (${{ matrix.suite }}): ${{ matrix.os }}", "test", ["Build: ubuntu-latest", "Build: windows-2025"]],
    ]);
});

test("an unreported job with an expression name is drawn under its id, as GitHub draws a matrix not yet expanded", () => {
    const yaml = `jobs:\n  build: {}\n  pytest:\n    name: "pytest \${{ matrix.db }}"\n    needs: build\n`;
    expect(shape(resolveRun(yaml, ran(["build"], "running")))).toEqual([
        ["build", "running", []],
        ["pytest", "queued", ["build"]],
    ]);
});

test("a call named by an expression matches the jobs it reports under the evaluated name, and draws the rest by id", () => {
    const yaml = `jobs:\n  release:\n    name: "Release \${{ inputs.channel }}"\n    uses: ./.github/workflows/release.yml\n`;
    const jobs = resolveRun(yaml, ran(["Release beta / plan", "Release beta / publish"]), releaseFile) ?? [];
    // What the evaluated name was is only known for what the run reported; the rest keep their place in the chain.
    expect(jobs.find((job) => job.name === "Release beta / publish")?.needs).toEqual([
        "Release beta / plan",
        "release / windows-build",
        "release / sandbox-arm64",
        "release / images-amd64",
    ]);
    expect(jobs.find((job) => job.name === "release / windows-build")?.needs).toEqual(["Release beta / plan"]);
});

test("a called job named only by an expression is still pinned by the caller's name in front of it", () => {
    const yaml = `jobs:\n  changes: {}\n  build-linux:\n    name: Build pnpr\n    needs: changes\n    uses: ./.github/workflows/build.yml\n`;
    const build = `jobs:\n  build:\n    name: \${{ inputs.os }}\n`;
    const jobs = resolveRun(yaml, ran(["changes", "Build pnpr / ubuntu-2404"]), new Map([[".github/workflows/build.yml", build]]));
    expect(shape(jobs)).toEqual([
        ["changes", "success", []],
        ["Build pnpr / ubuntu-2404", "success", ["changes"]],
    ]);
});
