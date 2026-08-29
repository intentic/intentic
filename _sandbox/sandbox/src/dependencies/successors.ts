import type { Ecosystem } from "./registry-freshness.js";

/* THE OTHER HALF OF A STALE DEPENDENCY: not an old version of the right package, an old CHOICE of package.
 *
 * A registry can settle "is there a newer release" on its own. It cannot settle "is this still the thing to
 * reach for", and that is the question behind most of the disappointment this feature exists for — the
 * request in this workspace's own history was to audit for "packages and load-bearing solutions implemented
 * using old tech that already has faster replacements", which no version comparison anywhere would answer.
 *
 * So this file is a JUDGEMENT, and it is built to be honest about being one. Two kinds of entry, with
 * different evidence behind them and different rules about when they may speak:
 *
 *   abandoned  , the incumbent is finished: deprecated by its own author, or self-declared inactive. The
 *                 registry CORROBORATES this, and the daemon refuses to say it unless the registry does
 *                 (agent-freshness.ts checks). So the curation here supplies only the NAME of the
 *                 replacement, and the fact that something is wrong stays a measurement. An entry that
 *                 quietly stops being true stops being said, without anyone having to notice.
 *
 *   superseded , the incumbent is alive, maintained, and perfectly defensible; something else is simply
 *                 faster or better kept now. Nothing in a registry can corroborate that, so it earns a much
 *                 narrower licence: it is said ONLY when a package is being ADDED for the first time, never
 *                 about a version already in a manifest. Choosing between two live options is a real decision
 *                 at the moment of `pnpm add`; second-guessing a dependency the project already committed to
 *                 is noise, and would be this feature's fastest route to being switched off.
 *
 * KEPT SHORT ON PURPOSE. Every entry is a claim somebody has to still agree with in a year. The bar for
 * adding one is that the replacement is the broad consensus rather than a preference, and the reason fits on
 * one line, because that line is what the model is given and what a reader will judge this list by. */

export type SuccessorKind = "abandoned" | "superseded";

export interface Successor {
    readonly ecosystem: Ecosystem;
    // Exactly as the manifest or the install command spells it.
    readonly from: string;
    readonly kind: SuccessorKind;
    // What to reach for instead. Plain prose, because the answer is sometimes a language feature rather than
    // a package and "use the platform" is a legitimate recommendation this list must be able to express.
    readonly to: string;
    // Why, in one clause. Appended after an em dash, so it has to read as a continuation of the sentence.
    readonly reason: string;
}

export const SUCCESSORS: readonly Successor[] = [
    // ---- abandoned: the registry itself will confirm these, or nothing is said ----
    { ecosystem: "npm", from: "request", kind: "abandoned", to: "undici, or the built-in fetch", reason: "it was deprecated in 2020 and takes no fixes" },
    { ecosystem: "npm", from: "node-sass", kind: "abandoned", to: "sass (dart-sass)", reason: "it binds a C++ library that no longer builds on current Node" },
    { ecosystem: "npm", from: "tslint", kind: "abandoned", to: "eslint or oxlint", reason: "it was retired in favour of typescript-eslint in 2019" },
    { ecosystem: "npm", from: "babel-eslint", kind: "abandoned", to: "@babel/eslint-parser", reason: "it is the same parser under its current name" },
    { ecosystem: "npm", from: "istanbul", kind: "abandoned", to: "c8, or vitest's own coverage", reason: "the project moved to nyc and then to native V8 coverage" },
    { ecosystem: "npm", from: "left-pad", kind: "abandoned", to: "String.prototype.padStart", reason: "the language has done this since ES2017" },
    { ecosystem: "npm", from: "querystring", kind: "abandoned", to: "URLSearchParams", reason: "the Node builtin it shadows is itself deprecated" },
    { ecosystem: "npm", from: "lodash.isequal", kind: "abandoned", to: "node:util isDeepStrictEqual", reason: "the single-method lodash packages are deprecated" },
    { ecosystem: "npm", from: "core-js", kind: "abandoned", to: "core-js 3", reason: "the 2.x line is deprecated and unpatched" },
    { ecosystem: "npm", from: "tsc-watch", kind: "abandoned", to: "tsc --watch", reason: "the compiler has covered this since 2.x" },
    { ecosystem: "pypi", from: "nose", kind: "abandoned", to: "pytest", reason: "it does not run on Python 3.10 or later" },
    { ecosystem: "pypi", from: "distutils", kind: "abandoned", to: "setuptools or hatch", reason: "it was removed from the standard library in 3.12" },

    // ---- superseded: said only at the moment of adding, never about what is already there ----
    { ecosystem: "npm", from: "moment", kind: "superseded", to: "date-fns, Day.js, or the Temporal API", reason: "moment is in maintenance mode and ships no new features" },
    { ecosystem: "npm", from: "mkdirp", kind: "superseded", to: "node:fs mkdir with recursive: true", reason: "the platform has covered this since Node 10" },
    { ecosystem: "npm", from: "rimraf", kind: "superseded", to: "node:fs rm with recursive: true", reason: "the platform has covered this since Node 14" },
    { ecosystem: "npm", from: "uuid", kind: "superseded", to: "crypto.randomUUID", reason: "the platform has covered v4 since Node 14.17" },
    { ecosystem: "npm", from: "dotenv", kind: "superseded", to: "node --env-file", reason: "Node reads env files itself since 20.6" },
    { ecosystem: "npm", from: "node-fetch", kind: "superseded", to: "the built-in fetch", reason: "Node has shipped fetch since 18" },
    { ecosystem: "npm", from: "chalk", kind: "superseded", to: "node:util styleText", reason: "Node has styled terminal text since 20.12" },
    { ecosystem: "npm", from: "eslint", kind: "superseded", to: "oxlint", reason: "the Rust rewrite runs the same class of rules ~50× faster" },
    { ecosystem: "npm", from: "prettier", kind: "superseded", to: "biome or oxfmt", reason: "the Rust formatters are an order of magnitude faster on a large tree" },
    { ecosystem: "npm", from: "webpack", kind: "superseded", to: "vite or rolldown", reason: "the esbuild/Rust bundlers start and rebuild far faster" },
    { ecosystem: "npm", from: "jest", kind: "superseded", to: "vitest", reason: "it shares the API and runs on the project's own transform pipeline" },
    { ecosystem: "npm", from: "ts-node", kind: "superseded", to: "tsx, or node --experimental-strip-types", reason: "both start faster and need no compiler on the path" },
    { ecosystem: "npm", from: "lerna", kind: "superseded", to: "pnpm workspaces with turbo or nx", reason: "the package managers absorbed workspace linking and publishing" },
    { ecosystem: "npm", from: "husky", kind: "superseded", to: "git's own core.hooksPath", reason: "one config line replaces the dependency" },
    { ecosystem: "pypi", from: "pip-tools", kind: "superseded", to: "uv", reason: "it resolves and installs the same lockfiles far faster" },
    { ecosystem: "pypi", from: "black", kind: "superseded", to: "ruff format", reason: "it is the same formatting rules in a Rust implementation" },
    { ecosystem: "pypi", from: "flake8", kind: "superseded", to: "ruff", reason: "it covers the same rule set and runs orders of magnitude faster" },
];

const INDEX = new Map(SUCCESSORS.map((entry) => [`${entry.ecosystem}\u0000${entry.from}`, entry]));

export const successorFor = (ecosystem: Ecosystem, name: string): Successor | undefined => INDEX.get(`${ecosystem}\u0000${name}`);
