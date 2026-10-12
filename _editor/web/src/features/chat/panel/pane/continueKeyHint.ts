import { t } from "@intentic/ui/i18n";
import type { ReopenPress } from "../../composer/composerIntent";
import { atReopenPhrase } from "../../run/endings/pickUp";

// What Enter does on the empty box, said under it: continue now, or at the reopen the button beside it names.
export const continueKeyHintOf = (offered: boolean, until: number | undefined, press: ReopenPress | undefined, now: number): string | undefined => {
    if (offered) {
        return t(`chat.chatPane.enterToContinue`);
    }
    if (until === undefined || press === undefined) {
        return undefined;
    }
    return atReopenPhrase(
        press === `book`
            ? { at: (when) => t(`chat.chatPane.enterToContinueAt`, { when }), in: (when) => t(`chat.chatPane.enterToContinueIn`, { when }) }
            : { at: (when) => t(`chat.chatPane.enterToSendAgainAt`, { when }), in: (when) => t(`chat.chatPane.enterToSendAgainIn`, { when }) },
        until,
        now,
    );
};
