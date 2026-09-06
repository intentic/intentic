/* The kit's pure composables, reachable WITHOUT the component barrel, the `./format` split, for the same
 * reason: a busy flag and a wall clock are plain state on vue's reactivity, and a node-environment test that
 * imports them must not drag every .vue component (and the theme reader's `document`) in behind them. Nothing
 * is exported here that the barrel does not also export. */
export { errorMessage, noticeFrom, noticeOf, useAsyncAction } from "../composables/useAsyncAction.js";
// The shape those return, type-only: a caller that HOLDS a notice (to compare it, or to hand it on) needs the
// type, and taking it from the barrel would pull every .vue component in behind it.
export type { NoticeAction, NoticeModel, NoticeTone } from "../components/feedback/notice.js";
export { useNow } from "../composables/useNow.js";
