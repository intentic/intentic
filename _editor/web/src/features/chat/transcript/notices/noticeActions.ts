import type { Component } from "vue";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import NoticeDepsInstall from "./NoticeDepsInstall.vue";
import NoticeHeld from "./NoticeHeld.vue";
import NoticeSwitchModel from "./NoticeSwitchModel.vue";
import NoticeWatchStop from "./NoticeWatchStop.vue";

/* The follow-up each notice action offers (TranscriptRow.noticeAction), drawn beside the notice's line or on its strip;
   each decides for itself whether it still stands. A low-memory hold is not here: it draws its whole row (NoticeMemory).
   `landHold` is only on rows stored before it stopped being offered. Each takes the `tier` its place draws it in. */

/** The component that draws a row's follow-up, or undefined where it offers none here. */
export const noticeActionOf = (message: ChatMessage): Component | undefined => {
    switch (message.noticeAction) {
        case `depsInstall`:
            return NoticeDepsInstall;
        case `watchStop`:
            return NoticeWatchStop;
        case `sendAgain`:
            return NoticeHeld;
        case `switchModel`:
            return NoticeSwitchModel;
        default:
            return undefined;
    }
};
