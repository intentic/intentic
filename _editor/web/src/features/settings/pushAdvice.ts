// Which sentence explains a window that can't take push notifications. Only iPhone and iPad browsers outside the Home
// Screen fix it by adding the app there; the Linux desktop app was told to do that in Safari.
export type PushUnsupported = `home-screen` | `desktop-app` | `browser`;

export const pushUnsupportedReason = (input: {
    readonly userAgent: string;
    // Inside the installed desktop app's own window (`desktopVersion()`).
    readonly desktopApp: boolean;
    // Already opened from the Home Screen (`display-mode: standalone`), where adding it again changes nothing.
    readonly standalone: boolean;
    // An iPad asks for the desktop site and reads as a Mac; its touch points give it away.
    readonly maxTouchPoints: number;
}): PushUnsupported => {
    if (input.desktopApp) {
        return `desktop-app`;
    }
    const ios = /iphone|ipad|ipod/i.test(input.userAgent) || (/macintosh/i.test(input.userAgent) && input.maxTouchPoints > 1);
    return ios && !input.standalone ? `home-screen` : `browser`;
};
