import type { WarmBand } from "../warmPlan";

/* WHICH AGENT REVIEWS ARE READ BEFORE THEY ARE OPENED, HOW NEAR EACH IS, AND HOW FAR DOWN IT IS READ.
 *
 * A LEAF — a pure projection over three ids, no store, no query, no Vue — for the same reason warmRows is one: the
 * source that builds the wishes and the test that pins this policy can both reach it without dragging in the app
 * shell.
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
 * Duplicates are therefore expected and harmless. */

/* How far down A REVIEW BEING READ the rows are taken — the same bound, and the same reason, as the workspace
 * review's (warmRows' WARM_LIMIT): far enough that an ordinary review is covered whole, since its numbers are what
 * this is for. The pathological case (a mass rename, a generated client) is what the bound is for, and its tail
 * shows a pending mark rather than a number that would change. */
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
): readonly ReviewToRead[] => [
    ...(open !== undefined && open !== `` ? [{ agentId: open, band: `now` as const, rows: WHOLE_REVIEW }] : []),
    ...(focused !== undefined && focused !== `` ? [{ agentId: focused, band: `near` as const, rows: WHOLE_REVIEW }] : []),
    ...attention.slice(0, MAX_ATTENTION_REVIEWS).map((agentId) => ({ agentId, band: `work` as const, rows: LIKELY_REVIEW })),
];
