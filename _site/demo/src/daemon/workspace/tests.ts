import { refuse } from "@intentic/contract-serve";
import { fileBody, workspaceEntries } from "../../fixture/workspace";
import { type JobLine, jobRunning, startJob } from "./jobs";
import { readManifest } from "./manifests";
import { monorepoOf, workspaceRepos } from "./repos";

// Test runs and installs, each a one-shot terminal like the daemon's: vitest over the named projects, counting the
// tests their files really hold, and the package manager over projects whose dependencies are missing.

const DIM = `\u001b[2m`;
const GREEN = `\u001b[32m`;
const CYAN = `\u001b[36m`;
const BOLD = `\u001b[1m`;
const RESET = `\u001b[0m`;
const prompt = (where: string): string => `${DIM}ada@acme-shop${RESET}:${CYAN}/work${where === `` ? `` : `/${where}`}${RESET}$ `;

const TEST_FILE = /\.(test|spec)\.[jt]sx?$/u;

// The test files under one project folder, with how many `it(`/`test(` cases each declares.
const suitesIn = (dir: string): { path: string; cases: string[] }[] =>
    [...workspaceEntries().keys()]
        .filter((path) => path.startsWith(`${dir}/`) && TEST_FILE.test(path) && !path.includes(`/node_modules/`))
        .map((path) => ({
            path: path.slice(dir.length + 1),
            cases: [...(fileBody(path) ?? ``).matchAll(/\b(?:it|test)\(\s*["'`]([^"'`]+)/gu)].map((match) => match[1] ?? ``),
        }));

const runLines = (repo: string, dir: string): JobLine[] => {
    const suites = suitesIn(dir);
    const count = suites.reduce((sum, suite) => sum + suite.cases.length, 0);
    return [
        { after: 80, text: `${prompt(dir)}vitest run\r\n\r\n` },
        { after: 800, text: ` ${DIM}RUN${RESET}  v3.2.4 ${DIM}/work/${dir}${RESET}\r\n\r\n` },
        ...suites.flatMap((suite) => [
            { after: 700, text: ` ${GREEN}✓${RESET} ${suite.path} ${DIM}(${suite.cases.length} test${suite.cases.length === 1 ? `` : `s`})${RESET}\r\n` },
            ...suite.cases.map((name) => ({ after: 150, text: `   ${GREEN}✓${RESET} ${name}\r\n` })),
        ]),
        { after: 500, text: `\r\n ${BOLD}Test Files${RESET}  ${GREEN}${suites.length} passed${RESET} (${suites.length})\r\n` },
        { after: 100, text: ` ${BOLD}     Tests${RESET}  ${GREEN}${count} passed${RESET} (${count})\r\n` },
        { after: 100, text: ` ${BOLD}  Duration${RESET}  ${(0.6 + suites.length * 0.4).toFixed(2)}s\r\n\r\n${prompt(repo)}` },
    ];
};

/** POST /workspace/repos/{repo}/tests: the named projects' tests, one after another, in `panel-<repo>--<session>`. */
export const runTests = (repo: string, session: string, dirs: readonly string[]): void => {
    monorepoOf(repo);
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(session)) {
        refuse(`invalid session`, 400);
    }
    const lines = dirs.flatMap((dir) => {
        if (dir.split(`/`).includes(`..`)) {
            refuse(`invalid test dir "${dir}"`, 400);
        }
        return runLines(repo, dir === `` ? repo : `${repo}/${dir}`);
    });
    startJob(`panel-${repo}--${session}`, { label: `${repo} · tests`, kind: `job`, lines, oneShot: true });
};

// Projects whose dependencies the sandbox installed, by root-relative folder.
const READY = new Set<string>();

const installLines = (dir: string, manager: string): JobLine[] => [
    { after: 80, text: `${prompt(dir)}${manager} install\r\n` },
    { after: 900, text: `Lockfile is up to date, resolution step is skipped\r\n` },
    { after: 1_200, text: `Packages: +238\r\n${GREEN}++++++++++++++++++++++++++++++++${RESET}\r\n` },
    { after: 1_000, text: `Progress: resolved 238, reused 231, downloaded 7, added 238, done\r\n${DIM}Done in 3.1s${RESET}\r\n${prompt(dir)}` },
];

/** POST /workspace/setup/install: each project with a manifest and nothing installed yet starts its install; ready,
 * running or unknown ones are skipped, and the answer says which started. */
export const install = (dirs: readonly string[]) => {
    const queued = dirs.filter((dir) => {
        const session = `install-${dir === `` ? `root` : dir.replaceAll(`/`, `-`)}`;
        const manifest = readManifest(dir === `` ? `package.json` : `${dir}/package.json`);
        if (manifest === undefined || READY.has(dir) || jobRunning(session)) {
            return false;
        }
        startJob(session, {
            label: `install ${dir === `` ? `workspace` : dir}`,
            kind: `job`,
            lines: installLines(dir, workspaceRepos().includes(dir) || dir.includes(`/`) ? `pnpm` : `npm`),
            oneShot: true,
            done: () => READY.add(dir),
        });
        return true;
    });
    return { queued };
};
