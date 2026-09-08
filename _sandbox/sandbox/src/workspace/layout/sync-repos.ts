import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { GitSyncResult } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import { discoverRepos } from "./repo-discovery.js";

// A repo's sync outcome for one turn: the git result, or "skipped" (throttled or already syncing), or "error".
// An error is a reported outcome, never a thrown turn.
export type RepoSyncOutcome = GitSyncResult | { readonly status: "skipped" } | { readonly status: "error"; readonly message: string };

export interface RepoSync {
    readonly repo: string;
    readonly outcome: RepoSyncOutcome;
}

// Process-global throttle + in-flight guard (single-tenant daemon): gates re-fetch, blocks concurrent syncs.
const lastSync = new Map<string, number>();
const inFlight = new Set<string>();

// Fetches and fast-forwards every discovered repo with a remote, in parallel; each failure isolates to its outcome.
// throttleMs === 0 forces a fetch (explicit Sync route); the turn hook passes 60s.
export const syncWorkspaceRepos = async (services: Services, throttleMs: number): Promise<RepoSync[]> => {
    const repos = await discoverRepos(services.workspace.root);
    const now = Date.now();
    return Promise.all(
        repos.map(async (repo): Promise<RepoSync> => {
            const dir = join(services.workspace.root, repo);
            if (inFlight.has(dir) || now - (lastSync.get(dir) ?? 0) < throttleMs) {
                return { repo, outcome: { status: "skipped" } };
            }
            inFlight.add(dir);
            try {
                const outcome = await services.git.sync(dir);
                lastSync.set(dir, now);
                return { repo, outcome };
            } catch (error) {
                return { repo, outcome: { status: "error", message: errorMessage(error) } };
            } finally {
                inFlight.delete(dir);
            }
        }),
    );
};

const commits = (n: number): string => `${n} ${n === 1 ? "commit" : "commits"}`;

// The note's fixed opening; turn-preamble.ts matches on it to both disclose and strip the note.
export const REPO_SYNC_NOTE_HEADER = "## Repos synced with their remotes";
// The chat-row title paired with REPO_SYNC_NOTE_HEADER (turn-preamble.ts).
export const REPO_SYNC_NOTE_TITLE = "Repos synced with their remotes";

// Prepends a note to the turn's prompt naming what moved and what it could NOT advance (context there may be stale).
// Clean, current, no-remote, and skipped repos add nothing.
export const syncAdvisory = (results: readonly RepoSync[]): string | undefined => {
    const notes = results.flatMap(({ repo, outcome }) => {
        switch (outcome.status) {
            case "updated":
                return [`${repo}: updated to latest (+${commits(outcome.behind)}, now at ${outcome.head}).`];
            case "dirty":
                return [
                    `${repo}: NOT updated, uncommitted changes, ${outcome.behind} behind origin. Your view here may be stale; commit and sync to integrate.`,
                ];
            case "diverged":
                return [`${repo}: NOT updated, ${commits(outcome.ahead)} not on origin and ${outcome.behind} behind. Your view here may be stale.`];
            case "error":
                return [`${repo}: sync failed (${outcome.message}).`];
            default:
                return [];
        }
    });
    return notes.length > 0 ? `${REPO_SYNC_NOTE_HEADER}\n\n${notes.join("\n")}` : undefined;
};
