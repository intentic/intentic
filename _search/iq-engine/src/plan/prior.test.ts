import { classPrior } from "./prior.js";

test.each([
    ["src/widget.ts", 1],
    ["config/app.yaml", 0.8],
    ["src/widget.test.ts", 0.6],
    ["tests/test_widget.py", 0.6],
    ["docs/guide.md", 0.5],
    ["CHANGELOG.md", 0.5],
    ["pnpm-lock.yaml", 0.3],
    ["go.sum", 0.3],
    ["assets/chart.svg", 0.3],
    ["dist/app.min.js", 0.3],
    ["src/__snapshots__/widget.test.ts.snap", 0.3],
    [".env.example", 0.3],
] as const)("classPrior(%s) = %d", (path, prior) => {
    expect(classPrior(path)).toBe(prior);
});
