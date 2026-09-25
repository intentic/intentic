import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import {
    REPO_CHECKS_FILE,
    type RepoCheck,
    type RepoCheckMoment,
    RepoChecksFileSchema,
    type RepoChecksSummary,
    type Rule,
    type RuleFirings,
} from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { checkCommandFor } from "../workspace/deps/verify-deps.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";

/* WHAT A REPOSITORY ASKS TO HAVE RUN ON ITS OWN CODE, read from the repository rather than from this sandbox's settings. */

// Same ceiling a rule's own command gets when the form leaves it unsaid.
const DEFAULT_TIMEOUT_MS = 900_000;

// The occasions that are rule moments. `land` is not one, it is the daemon's own run after a land (verify-deps.ts); and
// `turn` runs nothing any more: no check runs inside a conversation, so a declaration naming it still reads and is
// shown, but becomes no rule and is no part of what the owner adopts.
const MOMENT: Record<Exclude<RepoCheckMoment, "land" | "turn">, Rule["moment"]> = {
    edit: "file.edited",
};

/** One repository's declaration as it stands on disk, with the fingerprint adoption is measured against. */
export interface RepoDeclaration {
    readonly repo: string;
    readonly checks: readonly RepoCheck[];
    // Of the checks that can run, so re-indenting the file is not a change, rewriting a command is, and a retired `turn`
    // check is neither.
    readonly fingerprint: string;
    // What adoption was measured against before `turn` stopped counting, for a file that still names one: an owner who
    // adopted it then keeps it adopted.
    readonly formerFingerprint?: string;
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

// The checks that can run: every one but a retired `turn` check.
const standing = (checks: readonly RepoCheck[]): RepoCheck[] => checks.filter((check) => check.when !== "turn");

/** A repository's checks as a declaration, with what adoption is measured against. */
export const declarationOf = (repo: string, checks: readonly RepoCheck[]): RepoDeclaration => {
    const runnable = standing(checks);
    return {
        repo,
        checks,
        fingerprint: fingerprintOf(runnable),
        ...(runnable.length === checks.length ? {} : { formerFingerprint: fingerprintOf(checks) }),
    };
};

/** Reads one repository's declaration. Absent file ⇒ undefined: a repository that declares nothing is not a row. A
 *  file that exists but cannot be read is that repository's error row, never "declares nothing" and never every row's. */
export const readRepoDeclaration = async (root: string, repo: string): Promise<RepoDeclaration | undefined> => {
    let text: string | undefined;
    try {
        text = await readFile(join(root, repoChecksPath(repo)), "utf8").catch(undefinedIfMissing);
    } catch (error) {
        return { repo, checks: [], fingerprint: "", error: `the file could not be read (${errnoCode(error) ?? errorMessage(error)})` };
    }
    if (text === undefined) {
        return undefined;
    }
    try {
        return declarationOf(repo, RepoChecksFileSchema.parse(JSON.parse(text)).checks);
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

// Whether the owner's recorded answer is to this declaration as it stands.
const answers = (adopted: Readonly<Record<string, string>>, declaration: RepoDeclaration): boolean => {
    const recorded = adopted[declaration.repo];
    return recorded !== undefined && (recorded === declaration.fingerprint || recorded === declaration.formerFingerprint);
};

/** Whether what a repository declares now is what the owner said yes to. A changed declaration is held, not run; one
 *  that declares nothing that can run has nothing to adopt. */
export const isAdopted = (adopted: Readonly<Record<string, string>>, declaration: RepoDeclaration): boolean =>
    standing(declaration.checks).length > 0 && answers(adopted, declaration);

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

/** One declaration as rules, its land check and any retired turn check aside. Pure, so what a repository's file means
 *  can be tested without a workspace. Ids count every check in the file, so declaring a land check shifts no other
 *  check's history. */
export const rulesOf = (declaration: RepoDeclaration): Rule[] =>
    declaration.checks.flatMap((check, index) => {
        if (check.when === "land" || check.when === "turn") {
            return [];
        }
        const paths = globsOf(declaration.repo, check);
        const rule: Rule = {
            id: ruleId(declaration.repo, index),
            label: labelOf(check),
            moment: MOMENT[check.when],
            // The repo is the condition AND the working directory: rules/rule-cwd.ts runs a repo-scoped command there,
            // which is why a declared command reads exactly as it would in a terminal in that folder.
            when: { repo: declaration.repo, ...(paths === undefined ? {} : { paths }) },
            action: { kind: "command", command: check.run, timeoutMs: check.timeoutMs ?? DEFAULT_TIMEOUT_MS },
            enabled: true,
        };
        return [rule];
    });

/** The land check a declaration names; at most one, which the file schema enforces. */
export const landCheckOf = (declaration: RepoDeclaration): RepoCheck | undefined => declaration.checks.find((check) => check.when === "land");

/** What an adopted declaration runs after a land in one project directory ("" is the workspace root); undefined leaves
 *  the package's own verify or test script to run, as for a directory that is no repository's root. */
export const adoptedLandCheck = async (root: string, dir: string, adopted: Readonly<Record<string, string>>): Promise<RepoCheck | undefined> => {
    const declaration = await readRepoDeclaration(root, dir === "" ? "root" : dir);
    return declaration !== undefined && isAdopted(adopted, declaration) ? landCheckOf(declaration) : undefined;
};

/** The adopted declarations as rules, in repository order; what gets merged into the owner's own list. */
export const adoptedRules = (declarations: readonly RepoDeclaration[], adopted: Readonly<Record<string, string>>): Rule[] =>
    declarations.filter((declaration) => isAdopted(adopted, declaration)).flatMap(rulesOf);

/** What runs after a land in each repository whose root is a project, keyed by repo id: its package verify or test
 *  script, which a declared `land` check replaces. */
export const landDefaultsOf = async (deps: Pick<Services, "workspace" | "dependencies">): Promise<Map<string, string>> => {
    const [projects, repos] = await Promise.all([deps.dependencies.status(), discoverRepos(deps.workspace.root)]);
    const found = await Promise.all(
        projects
            .map((project) => ({ project, repo: project.dir === "" ? "root" : project.dir }))
            .filter(({ repo }) => repo === "root" || repos.includes(repo))
            .map(async ({ project, repo }) => [repo, await checkCommandFor(deps.workspace.root, project.dir, project.recipe.manager)] as const),
    );
    return new Map(found.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
};

/** One row per repository for a screen: what it declares, where that stands with the owner, when each check last spoke,
 *  and what runs after a land when it declares none. `landDefaults` is keyed by repo id; a repository with a default and
 *  no file is a row too. */
export const summariesOf = (
    declarations: readonly RepoDeclaration[],
    adopted: Readonly<Record<string, string>>,
    landDefaults: ReadonlyMap<string, string> = new Map(),
    firings: RuleFirings = {},
): RepoChecksSummary[] => {
    const declared = declarations.map((declaration): RepoChecksSummary => {
        const landDefault = landDefaults.get(declaration.repo);
        return {
            repo: declaration.repo,
            path: repoChecksPath(declaration.repo),
            checks: [...declaration.checks],
            fired: declaration.checks.map((check, index) => (check.when === "land" ? null : (firings[ruleId(declaration.repo, index)] ?? null))),
            adopted: isAdopted(adopted, declaration),
            // Only a repository adopted before can have changed; a first sighting is simply not adopted yet.
            changed: adopted[declaration.repo] !== undefined && !answers(adopted, declaration),
            ...(declaration.error === undefined ? {} : { error: declaration.error }),
            ...(landDefault === undefined || landCheckOf(declaration) !== undefined ? {} : { landDefault }),
        };
    });
    const undeclared = [...landDefaults]
        .filter(([repo]) => !declarations.some((declaration) => declaration.repo === repo))
        .map(([repo, landDefault]): RepoChecksSummary => ({ repo, path: repoChecksPath(repo), checks: [], fired: [], adopted: false, changed: false, landDefault }));
    return [...declared, ...undeclared].sort((left, right) => (left.repo === "root" ? -1 : right.repo === "root" ? 1 : left.repo.localeCompare(right.repo)));
};

export type RepoChecksDeps = Pick<Services, "workspace" | "sandboxSettings" | "logger">;

/* The declarations, remembered for a moment. */
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

/** The rules standing because a repository asked for them. */
export const repoCheckRules = async (deps: RepoChecksDeps): Promise<Rule[]> => {
    try {
        const [declarations, settings] = await Promise.all([recentDeclarations(deps.workspace.root, Date.now()), deps.sandboxSettings.get()]);
        return adoptedRules(declarations, settings.adoptedChecks);
    } catch (error) {
        deps.logger.warn({ err: error }, "repo checks: could not read what the repositories declare");
        return [];
    }
};

/** The owner's rules and the repositories' own, as one list. */
export const withRepoChecks = (owned: readonly Rule[], declared: readonly Rule[]): Rule[] => {
    const taken = new Set(owned.map((rule) => rule.id));
    return [...owned, ...declared.filter((rule) => !taken.has(rule.id))];
};
