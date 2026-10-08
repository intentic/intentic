import { isScratch, type GitDiffSide, type LandedMessageDraft, type RepoChanges, type RepoTarget } from "@intentic/sandbox-contract";
import { modelLabelFor } from "../../chat/accounts/providerCatalog";
import { originsOf, type OriginSummary } from "./changeOrigins";
import { truncatedTotal } from "./truncation";

// What the commit box records, named in the dock right above the message it goes with. Rows outside the scope stay
// listed and only dim, so nothing can enter a commit unseen.
// - staged: the index exactly as it stands, git's own selection.
// - everything: every change, staged first (scratch stays out, as every stage-everything leaves it out).
// - origin: one conversation's landed files, recorded alone with `commit --only`, so anything else already staged stays
//   staged and out of this commit.
// - yours: the files no conversation landed, recorded the same way.
export type CommitScope =
    { readonly kind: `staged` } | { readonly kind: `everything` } | { readonly kind: `origin`; readonly id: string } | { readonly kind: `yours` };

export const sameScope = (a: CommitScope, b: CommitScope): boolean =>
    a.kind === b.kind && (a.kind !== `origin` || (b.kind === `origin` && a.id === b.id));

// The scope a box opens on when nobody picked one: a conversation the commit was asked to be named after, then git's
// own selection when something is staged, then the one conversation whose work is all that is here, then everything.
export const defaultScope = (state: {
    readonly namedAfter: string | undefined;
    readonly staged: number;
    readonly legend: { readonly agents: readonly OriginSummary[]; readonly yours: number };
}): CommitScope => {
    const { namedAfter, staged, legend } = state;
    if (namedAfter !== undefined && legend.agents.some((entry) => entry.id === namedAfter)) {
        return { kind: `origin`, id: namedAfter };
    }
    if (staged > 0) {
        return { kind: `staged` };
    }
    const [only] = legend.agents;
    if (only !== undefined && legend.agents.length === 1 && legend.yours === 0) {
        return { kind: `origin`, id: only.id };
    }
    return { kind: `everything` };
};

// A picked scope that has nothing left to record falls back to the default, rather than holding an empty box.
export const scopeStillHolds = (
    scope: CommitScope,
    state: { readonly staged: number; readonly legend: { readonly agents: readonly OriginSummary[]; readonly yours: number } },
): boolean => {
    switch (scope.kind) {
        case `staged`:
            return state.staged > 0;
        case `everything`:
            return true;
        case `origin`:
            return state.legend.agents.some((entry) => entry.id === scope.id);
        case `yours`:
            return state.legend.yours > 0;
    }
};

// Whether a row is part of what Commit records. A conflict is never dimmed: it blocks every scope until resolved.
export const inScope = (scope: CommitScope, repo: RepoChanges, side: GitDiffSide, path: string): boolean => {
    if (side === `conflicted`) {
        return true;
    }
    if (scope.kind === `staged`) {
        return side === `staged`;
    }
    if (isScratch(path, repo.scratch ?? [])) {
        return false;
    }
    if (scope.kind === `everything`) {
        return true;
    }
    const ids = originsOf(repo, path);
    return scope.kind === `origin` ? ids.includes(scope.id) : ids.length === 0;
};

// One commit per repo the scope reaches, as the daemon is asked for it. `stage` and `only` are the commit call's own
// flags: a session's or your own files are named as a scope the daemon resolves, so a truncated list still commits all
// of them.
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
    // A repo enters when it lists something in scope, or truncated rows it can't attribute (the daemon decides those).
    const reached = repos.filter((repo) => pathsInScope(scope, repo).size > 0 || (scope.kind !== `staged` && truncatedTotal(repo) > 0));
    switch (scope.kind) {
        case `staged`:
            return {
                groups: repos.filter((repo) => repo.staged.length > 0 || (repo.truncated?.staged ?? 0) > 0).map((repo) => ({ repo: repo.repo })),
                stage: false,
                only: false,
            };
        case `everything`:
            return { groups: reached.map((repo) => ({ repo: repo.repo })), stage: true, only: false };
        case `origin`:
            return { groups: reached.map((repo) => ({ repo: repo.repo, scope: { origin: scope.id } })), stage: true, only: true };
        case `yours`:
            return { groups: reached.map((repo) => ({ repo: repo.repo, scope: { unlanded: true } })), stage: true, only: true };
    }
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
