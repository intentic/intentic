import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { GitSyncResult } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import { discoverRepos } from "./repo-discovery.js";

// A repo's sync outcome for one turn: the git result, plus the two turn-orchestration outcomes that aren't the
// git op itself, "skipped" (throttled, or a concurrent turn is already syncing this repo) and "error" (the
// fetch/merge threw, e.g. an unreachable remote). Errors become a reported outcome, never a thrown turn.
export type RepoSyncOutcome = GitSyncResult | { readonly status: "skipped" } | { readonly status: "error"; readonly message: string };

export interface RepoSync {
    readonly repo: string;
    readonly outcome: RepoSyncOutcome;
}

// Per-repo throttle + in-flight guard, process-global (the daemon is single-tenant). lastSync gates the network
// fetch so rapid multi-turn conversations don't re-fetch every turn; inFlight stops two concurrent turns from
// fast-forwarding the same repo at once.
const lastSync = new Map<string, number>();
const inFlight = new Set<string>();

// Fetch + guarded fast-forward every discovered repo that has a remote, so the agent's turn starts on current
// code. A neutral sandbox has none until DevOps scaffolds intent + desired-state (and an app is built); a
// never-created repo simply isn't discovered. Runs all repos in parallel; each repo's failure is isolated into
// its outcome so one unreachable remote can't fail the turn or block the others. `throttleMs === 0` forces a
// fetch (the explicit Sync route); the turn hook passes 60s.
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

/* The note's fixed opening, what turn-preamble.ts recognizes it by, in the list that decides both what the
 * chat discloses and what a restore strips back out of the stored message.
 *
 * It used to have neither. The advisory was pasted onto the front of the prompt by hand, which put it outside
 * every mechanism built for exactly this kind of text: the chat never mentioned it, and, because the stripper
 * only ever cuts an opening it knows, a reopened tab redrew the whole thing as a paragraph the user had
 * supposedly typed above their own words. */
export const REPO_SYNC_NOTE_HEADER = "## Repos synced with their remotes";
// The chat-row title, beside the header it belongs to (turn-preamble.ts explains the pairing).
export const REPO_SYNC_NOTE_TITLE = "Repos synced with their remotes";

// A note prepended to the turn's prompt so the agent knows what moved and which repos it could
// NOT advance (its context there may be stale). Clean/current/no-remote/skipped repos add nothing.
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
