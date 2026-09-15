/* The kit's pure composables, reachable WITHOUT the component barrel, the `./format` split, for the same reason. */
export { errorMessage, noticeFrom, noticeOf, useAsyncAction, useConcurrentActions } from "../composables/useAsyncAction.js";
// The shape those return, type-only: a caller that HOLDS a notice (to compare it, or to hand it on) needs the
// type, and taking it from the barrel would pull every .vue component in behind it.
export type { NoticeAction, NoticeModel, NoticeTone } from "../components/feedback/notice.js";
export { useNow } from "../composables/useNow.js";
