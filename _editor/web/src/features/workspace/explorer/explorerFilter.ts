import type { WorkspaceTreeEntry } from "@intentic/api-contract";

// Shared predicate for the toolbar's ignored/hidden-tests/technical filters, so the desktop tree and mobile listing
// agree on what a level holds. None truly hides: an ignored path opens by name, a hidden test or tooling file is a
// switch away. Matches by name, not path; pure, no framework code.

// Mirrors iq's CLASS_TESTS (scan.ts), widened by the Go/Rust `_test.` suffix; dots required on both sides.
const TEST_FILE = /\.(test|spec)\.|^test_|_test\./;
const TEST_DIRS = new Set([`__tests__`, `__test__`, `test`, `tests`, `spec`, `specs`, `e2e`]);

const isTestEntry = (name: string, type: WorkspaceTreeEntry["type"]): boolean => (type === `dir` ? TEST_DIRS.has(name) : TEST_FILE.test(name));

// Files that exist for tooling rather than for reading: what a maker's tree leaves out by default. A dot entry, a
// lockfile, a package or build manifest, a compiler's output, or a directory of dependencies or build products. Source
// stays: a maker's site is made of it, whether or not they read it.
const LOCKFILES = new Set([
    `package-lock.json`,
    `pnpm-lock.yaml`,
    `yarn.lock`,
    `bun.lockb`,
    `bun.lock`,
    `Cargo.lock`,
    `poetry.lock`,
    `uv.lock`,
    `Gemfile.lock`,
    `composer.lock`,
    `go.sum`,
]);
const MANIFESTS = new Set([
    `package.json`,
    `pnpm-workspace.yaml`,
    `tsconfig.json`,
    `jsconfig.json`,
    `Dockerfile`,
    `docker-compose.yml`,
    `docker-compose.yaml`,
    `Makefile`,
    `go.mod`,
    `Cargo.toml`,
    `pyproject.toml`,
    `requirements.txt`,
    `setup.py`,
    `setup.cfg`,
    `Gemfile`,
    `composer.json`,
    `LICENSE`,
    `LICENSE.md`,
    `CODEOWNERS`,
]);
const TOOLING_DIRS = new Set([`node_modules`, `dist`, `build`, `out`, `coverage`, `target`, `vendor`, `__pycache__`, `venv`]);
// `tsconfig.app.json`, `vite.config.ts`, `eslint.config.mjs`, `foo.d.ts`, `foo.js.map`, `foo.tsbuildinfo`.
const TOOLING_FILE = /^tsconfig\..*\.json$|\.config\.(js|ts|mjs|cjs|mts|cts)$|\.d\.ts$|\.map$|\.tsbuildinfo$/;

export const isTechnicalEntry = (name: string, type: WorkspaceTreeEntry["type"]): boolean => {
    if (name.startsWith(`.`)) {
        return true;
    }
    if (type === `dir`) {
        return TOOLING_DIRS.has(name);
    }
    return LOCKFILES.has(name) || MANIFESTS.has(name) || TOOLING_FILE.test(name) || isTestEntry(name, type);
};

export interface ExplorerFilters {
    readonly showIgnored: boolean;
    readonly hideTests: boolean;
    readonly hideTechnical: boolean;
}

export const explorerShows = (entry: WorkspaceTreeEntry, { showIgnored, hideTests, hideTechnical }: ExplorerFilters): boolean => {
    if (!showIgnored && entry.ignored === true) {
        return false;
    }
    if (hideTechnical && isTechnicalEntry(entry.name, entry.type)) {
        return false;
    }
    return !(hideTests && isTestEntry(entry.name, entry.type));
};

// How many of a level's entries the technical switch alone removed, for the chip that says so; ignored entries are the
// other switch's to count.
export const technicalHidden = (entries: readonly WorkspaceTreeEntry[], filters: ExplorerFilters): number =>
    filters.hideTechnical
        ? entries.filter((entry) => (filters.showIgnored || entry.ignored !== true) && isTechnicalEntry(entry.name, entry.type)).length
        : 0;
