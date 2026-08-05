import { expect, test } from "vitest";
import { resolveNeeds } from "./workflowGraph.js";

/* The translation this module exists for: `needs` is written in workflow job IDs, the jobs API answers in
 * display names, and matrices and reusable workflows mean those are not the same alphabet. Every test below
 * is a shape that appears in the workflow that prompted this — and the last few are the ways a matcher that
 * merely looks right quietly wires the graph to the wrong node. */

test("plain jobs — needs in both the string and the list spelling", () => {
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
    // The distinction the view depends on: [] draws a starting node, absent means fall back to timestamps.
    const resolved = resolveNeeds(`jobs:\n  preflight: {}\n`, ["preflight"]);
    expect(resolved.get("preflight")).toEqual([]);
    expect(resolved.has("preflight")).toBe(true);
});

test("a reusable workflow call — one declared job, several reported jobs, all of them dependents", () => {
    const yaml = `
jobs:
  preflight: {}
  verify-site:
    needs: preflight
    uses: ./.github/workflows/verify-site.yml
  release:
    needs: verify-site
`;
    // The called file contributes its own job names under the caller's, and it is not in front of us.
    const resolved = resolveNeeds(yaml, ["preflight", "verify-site / verify", "verify-site / e2e-hermetic", "release"]);
    expect(resolved.get("verify-site / verify")).toEqual(["preflight"]);
    expect(resolved.get("verify-site / e2e-hermetic")).toEqual(["preflight"]);
    // Depending on the caller means depending on everything the caller produced.
    expect(resolved.get("release")).toEqual(["verify-site / verify", "verify-site / e2e-hermetic"]);
});

test("a matrix — one declared job, one reported job per leg", () => {
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

test("the LONGEST label wins — `verify` must not claim `verify-core / verify`", () => {
    // Both are declared, and a plain startsWith would let the shorter id swallow the longer one's jobs,
    // hanging the whole verify-core branch off the wrong parent.
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
    // The rendered name ("leg ubuntu") matches nothing, so the id is what carries the leg.
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

test("a reported name nothing declares is left out entirely — no invented parent", () => {
    const resolved = resolveNeeds(`jobs:\n  build: {}\n`, ["build", "something-else-entirely"]);
    expect(resolved.has("something-else-entirely")).toBe(false);
});

test("anything that is not a readable workflow resolves to nothing at all", () => {
    expect(resolveNeeds(`name: ci\non: push\n`, ["build"]).size).toBe(0);
    expect(resolveNeeds(`just a string`, ["build"]).size).toBe(0);
    expect(resolveNeeds(``, ["build"]).size).toBe(0);
});
