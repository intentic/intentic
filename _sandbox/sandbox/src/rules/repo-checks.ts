import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_CHECKS_FILE, type RepoCheck, RepoChecksFileSchema, type RepoChecksSummary, type Rule } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";

/* WHAT A REPOSITORY ASKS TO HAVE RUN ON ITS OWN CODE, read from the repository rather than from this sandbox's
 * settings. A check command belongs beside the scripts it names: renaming `verify:push` and the check that calls it is
 * then one commit, a teammate's clone arrives already checked, and an agent proposing a check proposes a diff anyone
 * can read.
 *
 * It becomes an ordinary rule here (moment, condition, command) rather than a second engine: a declared check IS a rule
 * scoped to one repository, so everything already built on rules — ordering, firing stamps, the turn-ending note, the
 * push gate — reads it without knowing where it came from. What the repository may NOT say is what happens when it
 * fails; verdicts stay in the owner's settings, which is the whole of the line between the two files.
 *
 * Nothing declared runs until the owner adopts it (settings `adoptedChecks`), against a fingerprint of what was
 * declared at the time. Git has kept the same rule for hooks since the beginning: they are never cloned. */

// Same ceiling a rule's own command gets when the form leaves it unsaid.
const DEFAULT_TIMEOUT_MS = 900_000;

/** One repository's declaration as it stands on disk, with the fingerprint adoption is measured against. */
export interface RepoDeclaration {
    readonly repo: string;
    readonly checks: readonly RepoCheck[];
    // Of the checks themselves, so re-indenting the file is not a change and rewriting a command is.
    readonly fingerprint: string;
    // Present when the file exists but could not be read; `checks` is then empty, so a broken file runs nothing rather
    // than half of something.
    readonly error?: string;
}

/** Where the declaration lives, relative to the workspace; the path a screen shows whether or not the file exists. */
export const repoChecksPath = (repo: string): string => (repo === "root" ? REPO_CHECKS_FILE : `${repo}/${REPO_CHECKS_FILE}`);

// Over the checks as parsed, not the file's bytes: formatting a declaration must not read as a changed one, and a
// reordered list must, since order is the order they run in.
export const fingerprintOf = (checks: readonly RepoCheck[]): string =>
    createHash("sha256")
        .update(JSON.stringify(checks.map((check) => [check.when, check.run, check.timeoutMs ?? DEFAULT_TIMEOUT_MS, check.paths ?? []])))
        .digest("hex")
        .slice(0, 16);

/** Reads one repository's declaration. Absent file ⇒ undefined: a repository that declares nothing is not a row. */
export const readRepoDeclaration = async (root: string, repo: string): Promise<RepoDeclaration | undefined> => {
    let text: string;
    try {
        text = await readFile(join(root, repoChecksPath(repo)), "utf8");
    } catch {
        return undefined;
    }
    try {
        const { checks } = RepoChecksFileSchema.parse(JSON.parse(text));
        return { repo, checks, fingerprint: fingerprintOf(checks) };
    } catch (error) {
        // The repository's file to fix, and the reader's to report: a malformed declaration is stated on the row, never
        // guessed at.
        return { repo, checks: [], fingerprint: "", error: error instanceof Error ? error.message : String(error) };
    }
};

/** Every repository that declares checks, in id order. */
export const declaredRepoChecks = async (root: string): Promise<RepoDeclaration[]> => {
    // "root" first: the workspace's own repository is the one most sandboxes actually work in.
    const repos = ["root", ...(await discoverRepos(root))];
    const read = await Promise.all(repos.map((repo) => readRepoDeclaration(root, repo)));
    return read.filter((declaration): declaration is RepoDeclaration => declaration !== undefined);
};

/** Whether what a repository declares now is what the owner said yes to. A changed declaration is held, not run. */
export const isAdopted = (adopted: Readonly<Record<string, string>>, declaration: RepoDeclaration): boolean =>
    declaration.checks.length > 0 && adopted[declaration.repo] === declaration.fingerprint;

// A rule id is lowercase alphanumerics and dashes, so a repo id's slashes and dots become dashes. Prefixed, so a
// synthesized rule is recognisable in a log line and can never be mistaken for one the owner wrote.
const ruleId = (repo: string, index: number): string => `repo-check-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index + 1}`;

// Clipped to the daemon's own label ceiling, on a word boundary where there is one.
const labelOf = (check: RepoCheck): string => {
    const named = check.label ?? check.run;
    if (named.length <= 80) {
        return named;
    }
    const space = named.lastIndexOf(" ", 79);
    return `${named.slice(0, space > 40 ? space : 79)}…`;
};

// Repo-relative in the file, workspace-relative in a rule: globs are matched against the paths a turn reports, which
// are relative to the tree's root.
const globsOf = (repo: string, check: RepoCheck): string[] | undefined =>
    check.paths === undefined || check.paths.length === 0
        ? undefined
        : check.paths.map((glob) => (repo === "root" ? glob : `${repo}/${glob.replace(/^\.?\//, "")}`));

/** One declaration as rules. Pure, so what a repository's file means can be tested without a workspace. */
export const rulesOf = (declaration: RepoDeclaration): Rule[] =>
    declaration.checks.map((check, index) => {
        const paths = globsOf(declaration.repo, check);
        return {
            id: ruleId(declaration.repo, index),
            label: labelOf(check),
            moment: check.when === "push" ? "push.starting" : "turn.ending",
            // The repo is the condition AND the working directory: rules/rule-cwd.ts runs a repo-scoped command there,
            // which is why a declared command reads exactly as it would in a terminal in that folder.
            when: { repo: declaration.repo, ...(paths === undefined ? {} : { paths }) },
            action: { kind: "command", command: check.run, timeoutMs: check.timeoutMs ?? DEFAULT_TIMEOUT_MS },
            enabled: true,
        } satisfies Rule;
    });

/** The adopted declarations as rules, in repository order; what gets merged into the owner's own list. */
export const adoptedRules = (declarations: readonly RepoDeclaration[], adopted: Readonly<Record<string, string>>): Rule[] =>
    declarations.filter((declaration) => isAdopted(adopted, declaration)).flatMap(rulesOf);

/** One row per repository for a screen: what it declares, and where that stands with the owner. */
export const summariesOf = (declarations: readonly RepoDeclaration[], adopted: Readonly<Record<string, string>>): RepoChecksSummary[] =>
    declarations.map((declaration) => ({
        repo: declaration.repo,
        path: repoChecksPath(declaration.repo),
        checks: [...declaration.checks],
        adopted: isAdopted(adopted, declaration),
        // Only a repository adopted before can have changed; a first sighting is simply not adopted yet.
        changed: adopted[declaration.repo] !== undefined && adopted[declaration.repo] !== declaration.fingerprint,
        ...(declaration.error === undefined ? {} : { error: declaration.error }),
    }));

export type RepoChecksDeps = Pick<Services, "workspace" | "sandboxSettings" | "logger">;

/* The declarations, remembered for a moment. The push dialog polls the check's state several times a second while a
 * suite runs, and each poll asks what stands; reading every repository's file behind a tree walk that often would spend
 * real work to say what it said 300ms ago. Short enough that switching a repository on is felt by the next thing that
 * asks, and keyed by root so a test's temporary workspace can never answer for another's. The settings route reads
 * `declaredRepoChecks` directly and so is never served from here: a screen showing a file the reader has just edited
 * has to be right, not quick. */
const MEMO_MS = 2_000;
let memo: { readonly root: string; readonly at: number; readonly declarations: readonly RepoDeclaration[] } | undefined;

const recentDeclarations = async (root: string, now: number): Promise<readonly RepoDeclaration[]> => {
    if (memo !== undefined && memo.root === root && now - memo.at < MEMO_MS) {
        return memo.declarations;
    }
    const declarations = await declaredRepoChecks(root);
    memo = { root, at: now, declarations };
    return declarations;
};

/**
 * The rules standing because a repository asked for them. Adoption is read fresh every time (it is one field of the
 * settings the owner may have just changed); only the files themselves are memoised. Never throws — a failure here must
 * not take down the turn or the push it was consulted for.
 */
export const repoCheckRules = async (deps: RepoChecksDeps): Promise<Rule[]> => {
    try {
        const [declarations, settings] = await Promise.all([recentDeclarations(deps.workspace.root, Date.now()), deps.sandboxSettings.get()]);
        return adoptedRules(declarations, settings.adoptedChecks);
    } catch (error) {
        deps.logger.warn({ err: error }, "repo checks: could not read what the repositories declare");
        return [];
    }
};

/**
 * The owner's rules and the repositories' own, as one list. Owner first, so a rule they wrote decides before a
 * repository's at a first-match moment, and an id a repository would collide with is left to its owner.
 */
export const withRepoChecks = (owned: readonly Rule[], declared: readonly Rule[]): Rule[] => {
    const taken = new Set(owned.map((rule) => rule.id));
    return [...owned, ...declared.filter((rule) => !taken.has(rule.id))];
};
