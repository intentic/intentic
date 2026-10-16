import type { WarmBand } from "../warmPlan";

// Which agent reviews are warmed ahead of opening, how near each is, and how deep.
// Nearest first: open (`now`, whole), focused (`near`, whole), attention lane's head (`work`, shallow).
// Pure projection over ids, no store, no Vue; landed work goes to the workspace review, not read twice here.

// Rows read for a review being opened, matching warmRows' WARM_LIMIT: enough to cover an ordinary review.
const WHOLE_REVIEW = 120;

// Rows read for a review only likely to open; smaller since the attention lane is unbounded.
const LIKELY_REVIEW = 40;

// Attention-lane reviews read; three is the top of the lane, keeping this source's plan share small.
const MAX_ATTENTION_REVIEWS = 3;

export interface ReviewToRead {
    readonly agentId: string;
    readonly band: WarmBand;
    // How many of its rows to read, top of the list down.
    readonly rows: number;
}

export const reviewsToRead = (
    // The agent whose page is open, if the reader is on one.
    open: string | undefined,
    // The conversation the chat is pointing at, if any.
    focused: string | undefined,
    // The attention lane's agent ids, in the order the lane draws them.
    attention: readonly string[],
    // Agents whose work already sits in the workspace; skipped here since the workspace review covers them.
    landed: ReadonlySet<string> = new Set(),
): readonly ReviewToRead[] => {
    // The open page is exempt: it's on screen, so the same bytes being warm elsewhere is no answer for it.
    const worthReading = (agentId: string | undefined): agentId is string => agentId !== undefined && agentId !== `` && !landed.has(agentId);
    return [
        ...(open !== undefined && open !== `` ? [{ agentId: open, band: `now` as const, rows: WHOLE_REVIEW }] : []),
        ...(worthReading(focused) ? [{ agentId: focused, band: `near` as const, rows: WHOLE_REVIEW }] : []),
        ...attention
            .filter((agentId) => worthReading(agentId))
            .slice(0, MAX_ATTENTION_REVIEWS)
            .map((agentId) => ({ agentId, band: `work` as const, rows: LIKELY_REVIEW })),
    ];
};
