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
import { discoverRepos } from "../workspace/layout/repo-discovery.js";

/* WHAT A REPOSITORY ASKS TO HAVE RUN ON ITS OWN CODE, read from the repository rather than from this sandbox's settings. */

// Same ceiling a rule's own command gets when the form leaves it unsaid.
const DEFAULT_TIMEOUT_MS = 900_000;

// The occasions that are rule moments. `turn` runs once when an isolated turn is about to stop, and what it finds is
// said back to the model, which may fix it or say why not (agent/run/turn-checks.ts); it holds and refuses nothing.
// `land` runs nothing any more: no check runs after work lands (CI checks what the owner pushes), so a declaration
// naming it still reads and is shown, but becomes no rule and is no part of what the owner adopts.
const MOMENT: Record<Exclude<RepoCheckMoment, "land">, Rule["moment"]> = {
    edit: "file.edited",
    turn: "turn.ending",
};

/** One repository's declaration as it stands on disk, with the fingerprint adoption is measured against. */
export interface RepoDeclaration {
    readonly repo: string;
    readonly checks: readonly RepoCheck[];
    // Of the checks that can run, so re-indenting the file is not a change, rewriting a command is, and a retired `land`
    // check is neither.
    readonly fingerprint: string;
    // What adoption was measured against before `land` stopped counting, for a file that still names one and names no
    // `turn` check: an owner who adopted it then keeps it adopted.
    readonly formerFingerprints?: readonly string[];
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

// The checks that can run: every one but a retired `land` check.
const standing = (checks: readonly RepoCheck[]): RepoCheck[] => checks.filter((check) => check.when !== "land");

/** A repository's checks as a declaration, with what adoption is measured against. */
export const declarationOf = (repo: string, checks: readonly RepoCheck[]): RepoDeclaration => {
    const fingerprint = fingerprintOf(standing(checks));
    // Adoption was measured over every check until `turn` retired (2026-09-25), then over all but `turn` until `land`
    // did, then over the `edit` checks alone until `turn` came back as a check said back to the model. A file with a
    // `turn` check keeps none of those answers: an owner who said yes while that check ran nothing, or while it did
    // something else, never agreed to run its command at the end of every turn now, so the file waits for a new yes,
    // its `edit` checks with it. A file with no `turn` check keeps its answer, since what runs now is part of what was
    // agreed to: of its earlier fingerprints, only the one over all its checks differs from today's.
    const former = checks.some((check) => check.when === "turn") ? [] : [fingerprintOf(checks)].filter((earlier) => earlier !== fingerprint);
    return { repo, checks, fingerprint, ...(former.length === 0 ? {} : { formerFingerprints: former }) };
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
        return { repo, checks: [], fingerprint: "", error: errorMessage(error) };
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
    return recorded !== undefined && (recorded === declaration.fingerprint || declaration.formerFingerprints?.includes(recorded) === true);
};

/** Whether what a repository declares now is what the owner said yes to. A changed declaration is held, not run; one
 *  that declares nothing that can run has nothing to adopt. */
export const isAdopted = (adopted: Readonly<Record<string, string>>, declaration: RepoDeclaration): boolean =>
    standing(declaration.checks).length > 0 && answers(adopted, declaration);

// A rule id is lowercase alphanumerics and dashes, so a repo id's slashes and dots become dashes. Prefixed, so a
// synthesized rule is recognisable in a log line and can never be mistaken for one the owner wrote.
const RULE_ID_PREFIX = "repo-check-";
const ruleId = (repo: string, index: number): string => `${RULE_ID_PREFIX}${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index + 1}`;

/** Of `rules`, the commands a repository declared, never a rule the owner wrote: what may run at `turn.ending`, where an
 *  owner's rule left standing from before the moment came back (the retired `verify-ui-edits` built-in among them) stays
 *  inert. The id is the mark, and it holds: a declared rule never takes an id the owner used (withRepoChecks), and no
 *  save stands an owner's rule at `turn.ending` (the contract's SandboxSettingsWriteSchema). */
export const declaredChecks = (rules: readonly Rule[]): Rule[] =>
    rules.filter((rule) => rule.id.startsWith(RULE_ID_PREFIX) && rule.action.kind === "command");

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

/** One declaration as rules, any retired land check aside. Pure, so what a repository's file means can be tested
 *  without a workspace. Ids count every check in the file, so a retired check left in it shifts no other check's
 *  history. */
export const rulesOf = (declaration: RepoDeclaration): Rule[] =>
    declaration.checks.flatMap((check, index) => {
        if (check.when === "land") {
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

/** The adopted declarations as rules, in repository order; what gets merged into the owner's own list. */
export const adoptedRules = (declarations: readonly RepoDeclaration[], adopted: Readonly<Record<string, string>>): Rule[] =>
    declarations.filter((declaration) => isAdopted(adopted, declaration)).flatMap(rulesOf);

/** One row per repository for a screen: what it declares, where that stands with the owner, and when each check last
 *  spoke. */
export const summariesOf = (declarations: readonly RepoDeclaration[], adopted: Readonly<Record<string, string>>, firings: RuleFirings = {}): RepoChecksSummary[] =>
    declarations
        .map(
            (declaration): RepoChecksSummary => ({
                repo: declaration.repo,
                path: repoChecksPath(declaration.repo),
                checks: [...declaration.checks],
                fired: declaration.checks.map((check, index) => (check.when === "land" ? null : (firings[ruleId(declaration.repo, index)] ?? null))),
                adopted: isAdopted(adopted, declaration),
                // Only a repository adopted before can have changed; a first sighting is simply not adopted yet.
                changed: adopted[declaration.repo] !== undefined && !answers(adopted, declaration),
                ...(declaration.error === undefined ? {} : { error: declaration.error }),
            }),
        )
        .sort((left, right) => (left.repo === "root" ? -1 : right.repo === "root" ? 1 : left.repo.localeCompare(right.repo)));

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
