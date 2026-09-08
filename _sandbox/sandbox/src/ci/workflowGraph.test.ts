import { expect, test } from "vitest";
import { localWorkflowCalls, resolveNeeds } from "./workflowGraph.js";

// Pins resolveNeeds's job-id-to-display-name matching: needs uses job IDs, the jobs API reports display names, and
// matrices/reusable workflows diverge further.

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
    expect(resolveNeeds(first, ["loop / back / loop"], sources).has("loop / back / loop")).toBe(true);
});

test("localWorkflowCalls names the files in this repository and nothing else", () => {
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
    expect(localWorkflowCalls(yaml)).toEqual([".github/workflows/verify.yml"]);
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

test("needs on a job that never ran drops out rather than becoming an edge to nothing", () => {
    const yaml = `
jobs:
  build: {}
  slow-path:
    if: false
  ship:
    needs: [build, slow-path]
`;
    expect(resolveNeeds(yaml, ["build", "ship"]).get("ship")).toEqual(["build"]);
});

test("a reported name nothing declares is left out entirely: no invented parent", () => {
    const resolved = resolveNeeds(`jobs:\n  build: {}\n`, ["build", "something-else-entirely"]);
    expect(resolved.has("something-else-entirely")).toBe(false);
});

test("anything that is not a readable workflow resolves to nothing at all", () => {
    expect(resolveNeeds(`name: ci\non: push\n`, ["build"]).size).toBe(0);
    expect(resolveNeeds(`just a string`, ["build"]).size).toBe(0);
    expect(resolveNeeds(``, ["build"]).size).toBe(0);
});
