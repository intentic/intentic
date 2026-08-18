import type { WarmBand } from "../warmPlan";

/* WHICH AGENT REVIEWS ARE READ BEFORE THEY ARE OPENED, HOW NEAR EACH IS, AND HOW FAR DOWN IT IS READ.
 *
 * A LEAF — a pure projection over a handful of ids, no store, no query, no Vue — for the same reason warmRows is
 * one: the source that builds the wishes and the test that pins this policy can both reach it without dragging in
 * the app shell.
 *
 * The policy exists because of what reading a row's diff BUYS: the +/− the review prints beside it with the
 * comments taken out (useCodeStats). A review read only once its page is open has numbers that arrive while its
 * reader is scanning them — which is the one moment they must not move. So the list reaches back from the click to
 * the reviews a reader is about to open:
 *
 *   · THE OPEN ONE, in `now`, whole. Its rows are certainly being looked at.
 *   · THE ONE THE CHAT IS POINTING AT, in `near`, whole. On desktop that conversation sits beside every page in the
 *     app, and its review is one press from where the user's hand already is.
 *   · THE ATTENTION LANE, in `work`, and only its HEAD. A card is in that lane because it is asking the user for a
 *     decision, and the decision is taken by opening its review — so these are the likeliest next reviews from
 *     anywhere in the app. They are read shallowly because there are several of them and because the cost of being
 *     wrong about one is small: the moment it IS opened it becomes the `now` review above and is read whole.
 *
 * Everything else on the board contributes its file LIST and no rows — the difference between this being a few
 * hundred reads and being the thousands the loader exists not to make.
 *
 * NEAREST FIRST, because warmPlan takes the first declaration of a key: the open page usually IS the focused
 * conversation, and this ordering is what makes its rows land in the nearer band rather than a race deciding it.
 * Duplicates are therefore expected and harmless.
 *
 * AND WORK THAT HAS LANDED IS NOT READ TWICE.
 *
 * A clean turn lands as UNCOMMITTED changes in the user's own tree (the daemon's land.ts), so from that moment the
 * same file is reachable through two reviews at once — this one and the workspace's. They are not the same read
 * and cannot be made into one: this one asks "what did this agent do to this file", answered out of the agent's
 * own worktree against the base its conversation recorded, and its answer is deliberately fixed so that landing
 * does not empty it out; the workspace's asks "what is uncommitted here", answered out of the main tree against
 * HEAD and split by whether the row is staged, unstaged or conflicted. A partially staged file has two of the
 * latter and neither is the former. Two agents landing into one file, or a user edit after the land, part them
 * further. Filing both under one key would hand whichever review asked second the other one's diff.
 *
 * So the double read is removed by not making it: once an agent's work is in the workspace, THE WORKSPACE REVIEW
 * IS THE ONE READ AHEAD, and this one is left to be read when it is opened. That is the surface the user commits
 * from, it is warmed ahead of the board now (useBackgroundLoader), and a landed agent's own review is the rarer
 * visit — a look back at what one agent did, not the thing standing between the user and a commit. Its rows are
 * still read whole the moment its page IS open, which is the same bargain the rows past the caps below get: git's
 * counts hold at half weight until something reads them (ReviewStat). */

/* How far down A REVIEW BEING READ the rows are taken — the same bound, and the same reason, as the workspace
 * review's (warmRows' WARM_LIMIT): far enough that an ordinary review is covered whole, since its numbers are what
 * this is for. The pathological case (a mass rename, a generated client) is what the bound is for, and its tail
 * keeps git's counts as a provisional reading (ReviewStat) until something reads it. */
const WHOLE_REVIEW = 120;

/* And how far down one that is merely LIKELY to be opened. Deliberately much smaller: the attention lane is
 * unbounded — a fleet can leave a dozen agents waiting — and every row of it competes, in the same band, with the
 * workspace review the user is actually committing from. This covers most reviews outright (few are longer) while
 * leaving the plan room for the surface in front of the user. */
const LIKELY_REVIEW = 40;

// How many of the attention lane's reviews are read at all. Three is "the ones at the top of the lane", which is
// where the eye goes, and it keeps this whole source's share of the plan bounded by something small.
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
    /* The agents whose work is already in the workspace — see the header. Not read ahead here, because the
     * workspace review reads the same files and is warmed ahead of this. Defaulted empty so the projection stays
     * usable by a caller that has no roster to answer it from; the app's caller always does. */
    landed: ReadonlySet<string> = new Set(),
): readonly ReviewToRead[] => {
    // The OPEN page is exempt: the reader is looking at it, and "somewhere else has the same bytes under a
    // different question" is no answer to a pane that is on screen right now.
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
