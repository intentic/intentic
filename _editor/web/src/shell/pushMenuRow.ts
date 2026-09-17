import type { PushState } from "../push/usePushNotifications";
import { t } from "@intentic/ui/i18n";

// What the phone's Menu says about push on THIS device, since an agent that needs you and cannot reach you is the
// assistant failing at its one job. Nothing once it is on: a standing "you're set" row teaches the reader to skip
// the section.
export interface PushMenuRow {
    readonly message: string;
    readonly detail: string;
    readonly tone: "info" | "warning";
}

export const pushMenuRow = (state: PushState): PushMenuRow | undefined => {
    switch (state) {
        case `on`:
            return undefined;
        case `off`:
            return { message: t(`shell.pushMenuRow.getNotifiedAgentNeeds`), detail: t(`shell.pushMenuRow.pushNotificationsOffOn`), tone: `info` };
        case `denied`:
            return { message: t(`shell.pushMenuRow.notificationsBlockedApp`), detail: t(`shell.pushMenuRow.reAllowInBrowsers`), tone: `warning` };
        case `unsupported`:
            return { message: t(`shell.pushMenuRow.addToHomeScreen`), detail: t(`shell.pushMenuRow.browserCantReceivePush`), tone: `info` };
    }
};
