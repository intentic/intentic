import type { PushState } from "../push/usePushNotifications";

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
            return { message: `Get notified when an agent needs you`, detail: `Push notifications are off on this phone`, tone: `info` };
        case `denied`:
            return { message: `Notifications are blocked for this app`, detail: `Re-allow them in your browser's site settings`, tone: `warning` };
        case `unsupported`:
            return { message: `Add to your Home Screen to get notified`, detail: `This browser can't receive push until the app is installed`, tone: `info` };
    }
};
