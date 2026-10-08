import { isScratch, type GitDiffSide, type LandedMessageDraft, type RepoChanges, type RepoTarget } from "@intentic/sandbox-contract";
import { modelLabelFor } from "../../../chat/accounts/providerCatalog";
import { originsOf } from "../changeOrigins";
import { truncatedTotal } from "../truncation";

// What Commit records, git's way: the index when something is staged, else everything (staged first, scratch left out,
// as every stage-everything leaves it out). What gets staged is picked in the list (a row's +) or by the scope chips
// (useCommitScope.ts), so the Staged section is always the whole answer.
export type CommitScope = { readonly kind: `staged` } | { readonly kind: `everything` };

export const commitScopeFor = (staged: number): CommitScope => (staged > 0 ? { kind: `staged` } : { kind: `everything` });

// Whether a row is part of what Commit records. A conflict always counts: it blocks the commit until resolved.
export const inScope = (scope: CommitScope, repo: RepoChanges, side: GitDiffSide, path: string): boolean => {
    if (side === `conflicted`) {
        return true;
    }
    if (scope.kind === `staged`) {
        return side === `staged`;
    }
    return !isScratch(path, repo.scratch ?? []);
};

// One commit per repo the scope reaches, as the daemon is asked for it; `stage` is the commit call's own flag.
export interface ScopeCommit {
    readonly groups: readonly RepoTarget[];
    readonly stage: boolean;
    readonly only: boolean;
}

// Paths of a repo that answer to the scope, among the rows the review listed.
export const pathsInScope = (scope: CommitScope, repo: RepoChanges): ReadonlySet<string> => {
    const paths = new Set<string>();
    for (const side of [`staged`, `unstaged`] as const) {
        for (const change of repo[side]) {
            if (inScope(scope, repo, side, change.path)) {
                paths.add(change.path);
            }
        }
    }
    return paths;
};

export const scopeCommit = (scope: CommitScope, repos: readonly RepoChanges[]): ScopeCommit => {
    if (scope.kind === `staged`) {
        return {
            groups: repos.filter((repo) => repo.staged.length > 0 || (repo.truncated?.staged ?? 0) > 0).map((repo) => ({ repo: repo.repo })),
            stage: false,
            only: false,
        };
    }
    // A repo enters when it lists something, or truncated rows the daemon will decide on.
    const reached = repos.filter((repo) => pathsInScope(scope, repo).size > 0 || truncatedTotal(repo) > 0);
    return { groups: reached.map((repo) => ({ repo: repo.repo })), stage: true, only: false };
};

// Files the scope covers among the listed rows, and whether that is the whole of it (no repo it reaches truncated).
export const scopeFiles = (scope: CommitScope, repos: readonly RepoChanges[]): { readonly files: number; readonly complete: boolean } => {
    const reached = new Set(scopeCommit(scope, repos).groups.map((group) => group.repo));
    const counted = repos.filter((repo) => reached.has(repo.repo));
    return {
        files: counted.reduce((total, repo) => total + pathsInScope(scope, repo).size, 0),
        complete: !counted.some((repo) => truncatedTotal(repo) > 0),
    };
};

// The one session a commit of `scope` is wholly the work of, for the message box to take its drafted sentence: every
// staged file landed by it, or, with nothing staged, the only session here with no edits of anyone else's beside it.
export const namingOrigin = (scope: CommitScope, repos: readonly RepoChanges[]): string | undefined => {
    let candidates: Set<string> | undefined;
    for (const repo of repos) {
        for (const path of pathsInScope(scope, repo)) {
            const ids = originsOf(repo, path);
            candidates = new Set(candidates === undefined ? ids : ids.filter((id) => candidates!.has(id)));
            if (candidates.size === 0) {
                return undefined;
            }
        }
    }
    return candidates?.size === 1 ? [...candidates][0] : undefined;
};

// The one line under the message box that says how its drafted message is going. Same height in every state, so the
// box and the button under it never move as a draft runs, lands or fails.
export type DraftLine =
    | { readonly state: `reading` }
    | { readonly state: `asking`; readonly model: string; readonly since: number | undefined; readonly refused: number }
    | { readonly state: `written`; readonly model: string | undefined }
    | { readonly state: `failed`; readonly refused: number }
    | { readonly state: `none` };

export const draftLine = (draft: LandedMessageDraft | undefined, hasMessage: boolean): DraftLine => {
    if (draft === undefined) {
        return hasMessage ? { state: `written`, model: undefined } : { state: `none` };
    }
    const refused = draft.steps.filter((step) => step.status === `refused`).length;
    const answered = draft.steps.find((step) => step.status === `answered`);
    if (draft.outcome === `written`) {
        return { state: `written`, model: answered === undefined ? undefined : modelLabelFor(answered.provider, answered.model) };
    }
    if (draft.outcome === `failed`) {
        return { state: `failed`, refused };
    }
    const asking = draft.steps.findLast((step) => step.status === `asking`);
    return asking === undefined
        ? { state: `reading` }
        : { state: `asking`, model: modelLabelFor(asking.provider, asking.model), since: asking.at, refused };
};
