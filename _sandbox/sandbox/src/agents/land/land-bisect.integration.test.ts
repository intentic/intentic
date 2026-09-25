import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import { type BisectDeps, bisectSuspects, type RerunRunner } from "./land-bisect.js";
import type { LandSuspect } from "./land-fix.js";

// Real git for what bisect does to a repository (a detached scratch worktree per suspect, removed after), and a stand-in
// for the check's own re-run: it reads the tree it was started in and answers the rerun contract's exit codes.

const FAILING = "app#test src/parser.test.ts › parses a heading";

const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    }).trim();

const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A main line with one file the check reads, and a branch per suspect landed on it: `broken` breaks the parser, `docs`
// changes nothing the check reads. Each branch's tip is what its conversation recorded as landed.
const repository = (): { readonly main: string; readonly tips: Readonly<Record<"broken" | "docs", string>> } => {
    const main = realpathSync(mkdtempSync(join(tmpdir(), "land-bisect-repo-")));
    made.push(main);
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "parser.txt"), "parses\n");
    writeFileSync(join(main, ".gitignore"), "node_modules/\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "base");
    const branch = (name: string, file: string, content: string): string => {
        git(main, "checkout", "-q", "-b", `agent/${name}`, "main");
        writeFileSync(join(main, file), content);
        git(main, "commit", "-q", "-am", name);
        const tip = git(main, "rev-parse", "HEAD");
        git(main, "checkout", "-q", "main");
        return tip;
    };
    writeFileSync(join(main, "README.md"), "readme\n");
    git(main, "add", "README.md");
    git(main, "commit", "-q", "-m", "readme");
    return { main, tips: { broken: branch("broken", "parser.txt", "throws\n"), docs: branch("docs", "README.md", "better readme\n") } };
};

const suspect = (agentId: string, tip: string | undefined): LandSuspect => ({
    land: { kind: "land", agentId, branch: `agent/${agentId}`, repos: [{ repo: "root", from: "base", dir: "" }] },
    paths: [],
    from: "base",
    tip,
});

// The repository lock bisect takes around every worktree write, noted so the suite can say it was held.
const depsOver = (main: string): { readonly deps: BisectDeps; readonly locked: string[]; readonly lines: Record<string, unknown>[] } => {
    const locked: string[] = [];
    const { lines, logger } = recordingLogger();
    const deps: BisectDeps = {
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
            mainDir: (repo) => (repo === "root" ? main : join(main, repo)),
            withRepoLock: async (repo, act) => {
                locked.push(repo);
                return act();
            },
        }),
        logger,
    };
    return { deps, locked, lines };
};

// What one re-run was handed, read while it ran: its tree and the units file are gone the moment it returns.
interface Rerun {
    readonly command: string;
    readonly cwd: string;
    readonly units: unknown;
    readonly parser: string;
    readonly mirrored: boolean;
}

// The rerun contract: 1 when the tree reproduces a failure, 0 when none did, anything else when it cannot say.
const rerunner = (answer: (parser: string) => number | undefined): { readonly run: RerunRunner; readonly reruns: Rerun[] } => {
    const reruns: Rerun[] = [];
    const run: RerunRunner = async (command, cwd, env) => {
        const parser = readFileSync(join(cwd, "parser.txt"), "utf8").trim();
        reruns.push({
            command,
            cwd,
            units: JSON.parse(readFileSync(env["INTENTIC_RERUN_UNITS"] ?? "", "utf8")),
            parser,
            mirrored: existsSync(join(cwd, "node_modules", "left-pad", "index.js")),
        });
        return answer(parser);
    };
    return { run, reruns };
};

const reproduces = (parser: string): number => (parser === "throws" ? 1 : 0);

const worktreesOf = (main: string): string[] =>
    git(main, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree "));

test("of two suspects, only the one whose own landed tree reproduces the failures is returned", async () => {
    const { main, tips } = repository();
    const { deps, locked } = depsOver(main);
    const { run, reruns } = rerunner(reproduces);
    const [broken, docs] = [suspect("broken", tips.broken), suspect("docs", tips.docs)];

    const found = await bisectSuspects(deps, { project: "", suspects: [docs, broken], failures: [FAILING], rerun: "pnpm rerun" }, undefined, run);

    expect(found).toEqual([broken]);
    // One at a time, each on its own tree at its own tip, handed only the failures, by the check's own command.
    expect(reruns.map(({ command, units, parser }) => ({ command, units, parser }))).toEqual([
        { command: "pnpm rerun", units: [FAILING], parser: "parses" },
        { command: "pnpm rerun", units: [FAILING], parser: "throws" },
    ]);
    expect(new Set(reruns.map(({ cwd }) => cwd)).size).toBe(2);
    expect(locked).toEqual(["root", "root", "root", "root"]);
    // Nothing is left behind: the scratch worktrees are gone from git and from disk, and the main tree is as it was.
    expect(worktreesOf(main)).toEqual([`worktree ${main}`]);
    expect(reruns.filter(({ cwd }) => existsSync(cwd))).toEqual([]);
    expect(git(main, "status", "--porcelain")).toBe("");
});

// Symlinks only, the way an agent's worktree reads the main tree's installs; nothing the re-run writes can land.
test("a suspect's tree reads the main tree's installed dependencies", async () => {
    const { main, tips } = repository();
    mkdirSync(join(main, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(main, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    const { deps } = depsOver(main);
    const { run, reruns } = rerunner(reproduces);

    await bisectSuspects(
        deps,
        { project: "", suspects: [suspect("broken", tips.broken), suspect("docs", tips.docs)], failures: [FAILING], rerun: "r" },
        undefined,
        run,
    );

    expect(reruns.map(({ mirrored }) => mirrored)).toEqual([true, true]);
    expect(worktreesOf(main)).toEqual([`worktree ${main}`]);
});

test.each([
    ["one tree's re-run cannot say (it had nothing it could re-run alone)", (parser: string) => (parser === "throws" ? 1 : 2)],
    ["one tree's re-run died or ran out of time", (parser: string) => (parser === "throws" ? 1 : undefined)],
    ["no tree reproduces them, so the break needs the lands together", () => 0],
] as const)("the answer is unknown when %s", async (_case, answer) => {
    const { main, tips } = repository();
    const { deps } = depsOver(main);
    const { run, reruns } = rerunner(answer);

    expect(
        await bisectSuspects(
            deps,
            { project: "", suspects: [suspect("broken", tips.broken), suspect("docs", tips.docs)], failures: [FAILING], rerun: "r" },
            undefined,
            run,
        ),
    ).toBeUndefined();
    expect(reruns).toHaveLength(2);
    expect(worktreesOf(main)).toEqual([`worktree ${main}`]);
});

test("a suspect with no landed tip to check out makes the answer unknown without a tree for it", async () => {
    const { main, tips } = repository();
    const { deps } = depsOver(main);
    const { run, reruns } = rerunner(reproduces);

    expect(
        await bisectSuspects(
            deps,
            { project: "", suspects: [suspect("broken", tips.broken), suspect("gone", undefined)], failures: [FAILING], rerun: "r" },
            undefined,
            run,
        ),
    ).toBeUndefined();
    expect(reruns.map(({ parser }) => parser)).toEqual(["throws"]);
});

test("a tree whose re-run throws is unknown, said once, and still removed", async () => {
    const { main, tips } = repository();
    const { deps, lines } = depsOver(main);
    const run: RerunRunner = async () => {
        throw new Error("spawn bash ENOENT");
    };

    expect(
        await bisectSuspects(
            deps,
            { project: "", suspects: [suspect("broken", tips.broken), suspect("docs", tips.docs)], failures: [FAILING], rerun: "r" },
            undefined,
            run,
        ),
    ).toBeUndefined();
    expect(lines.filter(({ level }) => level === "warn").map(({ message, conversationId }) => ({ message, conversationId }))).toEqual([
        { message: "land bisect: a suspect's tree could not be asked", conversationId: "broken" },
        { message: "land bisect: a suspect's tree could not be asked", conversationId: "docs" },
    ]);
    expect(worktreesOf(main)).toEqual([`worktree ${main}`]);
});

// Past a handful the re-runs cost more than the fresh conversation that would tell the suspects apart.
test.each([
    ["one suspect, which needs no telling apart", 1],
    ["five suspects, more than a re-run each is worth", 5],
] as const)("nothing is re-run for %s", async (_case, count) => {
    const { main, tips } = repository();
    const { deps, locked } = depsOver(main);
    const { run, reruns } = rerunner(reproduces);
    const suspects = Array.from({ length: count }, (_, index) => suspect(`s${index}`, tips.broken));

    expect(await bisectSuspects(deps, { project: "", suspects, failures: [FAILING], rerun: "r" }, undefined, run)).toBeUndefined();
    expect(reruns).toEqual([]);
    expect(locked).toEqual([]);
});
