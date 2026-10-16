#!/usr/bin/env node
// Every package (a directory with a package.json, Cargo.toml, pyproject.toml or go.mod, found the way
// `intentic-docs validate` finds them: lib/readme-packages.mjs) has a README.md with an H1 and a lead sentence under
// it, the package's one-liner wherever it is named. Its Key files links are md-links's to resolve.
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root, subjectScope } from "./lib/repo.mjs";
import { discoverPackages, readmeProblem } from "./lib/readme-packages.mjs";

const scope = subjectScope();
// Scoped, a package is judged when a named path lies inside it: its README, its manifest, any file of its own.
const inScope = (dir) => scope === undefined || [...scope].some((path) => path === dir || path.startsWith(`${dir}/`));
const judged = discoverPackages(root).filter(inScope);

const WHY = {
    missing: "has no README.md: every package is documented by its own",
    "no-h1": "has a README.md with no `# H1`: the heading names the package",
    "no-lead": "has a README.md with no lead sentence under its H1: that sentence is the package's one-liner",
};
const findings = judged.flatMap((dir) => {
    const problem = readmeProblem(root, dir);
    return problem === undefined ? [] : [`${join(dir, "README.md")}: ${dir} ${WHY[problem]}`];
});

finish(
    [["a package's README.md is missing or says nothing about it", findings]],
    [`package readmes: ${judged.length} packages carry a README.md with an H1 and a lead sentence`],
);
