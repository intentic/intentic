import { sandboxNoticeOf } from "@intentic/sandbox-contract/events/sandbox-notice";
import type { AgentSummary, HomeCommit } from "@intentic/sandbox-contract/schemas/agents";
import { messageOr } from "@intentic/ui/async";
import { reactive } from "vue";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import type { ChatMessage } from "../conversations/transcript/transcript";

// WHAT A HOME CONVERSATION'S LANDS BECAME IN HISTORY. A home lands what it merged and commits it by itself (the daemon's
// version-landed.ts), so its `landed` row names the land (`params.land`) and its card files the commit under the same
// name a few seconds later, once the subject is drafted (AgentSummary.commits, the newest few only). This reads one
// against the other, says the commit in a line, and takes it back.

/** The land a `landed` row names; undefined for any other row, and for a land from before lands were named. */
export const landOfRow = (message: Pick<ChatMessage, "role" | "noticeCode">): string | undefined => {
    if (message.role !== `notice` || message.noticeCode?.code !== `landed`) {
        return undefined;
    }
    const notice = sandboxNoticeOf(message);
    return notice?.code === `landed` && notice.params?.land !== `` ? notice.params?.land : undefined;
};

/** The commit a land became, as the card filed it; undefined until it is filed, and once it has aged off the card. */
export const homeCommitOf = (card: Pick<AgentSummary, "commits"> | undefined, land: string | undefined): HomeCommit | undefined =>
    land === undefined ? undefined : card?.commits?.find((commit) => commit.land === land);

// The length git itself abbreviates to, and every history view here shows.
const SHORT_SHA = 7;

/** The commit's own shas, short: one bare, several each named by its repository ("root abc1234 · web def5678"). */
export const commitShas = (commit: Pick<HomeCommit, "commits">): string => {
    const [only, ...more] = commit.commits;
    if (only !== undefined && more.length === 0) {
        return only.sha.slice(0, SHORT_SHA);
    }
    return commit.commits.map(({ repo, sha }) => `${repo} ${sha.slice(0, SHORT_SHA)}`).join(` · `);
};

// The lands this window has taken back, so a row scrolled away and drawn again still says so: nothing on the card does.
// allow(module-state): one window's own presses, gone with the page like the press itself
const revertedLands = reactive(new Set<string>());

/** Whether this window has already taken the land back. */
export const reverted = (commit: Pick<HomeCommit, "land">): boolean => revertedLands.has(commit.land);

/** What a revert could not take back, per repository, in git's own words. */
export interface RevertRefusal {
    readonly repo: string;
    readonly reason: string;
}

/**
 * Takes a land back: a commit reversing each of its own, newest first, so history keeps both. Every repository is
 * tried, since each took its own commit and one refusing leaves the others' revert standing on its own; what refused
 * comes back, empty when all of it went.
 */
export const revertHomeCommit = async (commit: Pick<HomeCommit, "land" | "commits">, at: string | undefined): Promise<RevertRefusal[]> => {
    const refused: RevertRefusal[] = [];
    for (const { repo, sha } of commit.commits.toReversed()) {
        try {
            const answer = await sandboxRpc.git.revert({ repo, sha }, { context: { at } });
            if (!answer.ok) {
                refused.push({ repo, reason: answer.reason ?? `` });
            }
        } catch (error) {
            refused.push({ repo, reason: messageOr(error, ``) });
        }
    }
    if (refused.length === 0) {
        revertedLands.add(commit.land);
    }
    return refused;
};
