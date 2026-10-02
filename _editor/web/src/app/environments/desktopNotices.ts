import { type Ref, ref } from "vue";
import { desktopApp, openDesktopLink } from "./desktop";

// The desktop app's own notifications and the mark on its icon, as the workspace asks for them (desktop-app notice.rs,
// badge.rs), one link each and built here alone. Like every link to the app, a navigation the app intercepts, never IPC.
// What to say and when is the browser tab's (shell/browser-tab/desktopSignal.ts); this file only carries it.

/** Whether this window's app puts up notifications and marks its icon: false in a browser and in an app from before. */
export const desktopNotices = (): boolean => desktopApp()?.notices === true;

// What the app holds a value to (setup_link.rs): one line, bounded. Text is cut by characters, never inside one, and a
// control character is a space, since the app drops a link carrying one rather than guess at it.
const CONTROL = /\p{Cc}/gu;
const oneLine = (text: string, max: number): string => Array.from(text.replace(CONTROL, ` `).trim()).slice(0, max).join(``);

const TITLE_MAX = 200;
const BODY_MAX = 400;
const KEY_MAX = 200;
const TOOLTIP_MAX = 100;

/* THE TAB'S MARK, FOR THE APP'S ICON. */

export type DesktopBadgeMark = `none` | `asks` | `done` | `working` | `offline`;

export interface DesktopBadge {
    readonly mark: DesktopBadgeMark;
    /** What needs the reader, for a dock that draws a count; the app reads it for `asks` alone. */
    readonly count: number;
    /** What the mark means, after the app's name in the tray's tooltip. */
    readonly tooltip?: string;
    /** The app's icon with the mark on it, as unpadded URL-safe base64 of a PNG: the tray's icon. */
    readonly icon?: string;
    /** The mark alone, in the same encoding: the overlay on the Windows taskbar's button. */
    readonly overlay?: string;
}

export const desktopBadgeLink = (badge: DesktopBadge): string => {
    const params = new URLSearchParams({ mark: badge.mark });
    if (badge.mark === `asks`) {
        params.set(`count`, String(Math.max(0, Math.round(badge.count))));
    }
    const tooltip = badge.tooltip === undefined ? `` : oneLine(badge.tooltip, TOOLTIP_MAX);
    if (tooltip !== ``) {
        params.set(`tooltip`, tooltip);
    }
    if (badge.icon !== undefined) {
        params.set(`icon`, badge.icon);
    }
    if (badge.overlay !== undefined) {
        params.set(`overlay`, badge.overlay);
    }
    return `intentic://badge?${params.toString()}`;
};

// The last badge handed over, so a mark drawn again the same sends nothing.
let badgeSent: string | undefined;

/** Puts the mark on the app's icon, when it differs from what the app was last told; nothing outside the app. */
export const announceDesktopBadge = (badge: DesktopBadge): void => {
    if (!desktopNotices()) {
        return;
    }
    const link = desktopBadgeLink(badge);
    if (link === badgeSent) {
        return;
    }
    badgeSent = link;
    openDesktopLink(link);
};

/* THE SYSTEM'S NOTIFICATIONS. */

export interface DesktopNotice {
    /** What it is about (an agent, a held wake), so the same key replaces it and withdraws it once settled. */
    readonly key: string;
    /** Something needs the reader, or a turn finished: the sound it gets where the system lets the app pick one. */
    readonly kind: `asks` | `finished`;
    readonly title: string;
    readonly body?: string;
    /** The workspace route a press on it opens; none for the workspace as it is. */
    readonly path?: string;
    /** No sound of its own: a chime rings for it, or one a moment ago already made a sound. */
    readonly silent: boolean;
}

// A route of this page, as the app takes one: rooted, never `//`, which a navigation reads as another host.
const PAGE_ROUTE = /^\/(?!\/)/;

export const desktopNoticeLink = (notice: DesktopNotice): string => {
    const params = new URLSearchParams({ do: `show`, key: oneLine(notice.key, KEY_MAX), kind: notice.kind });
    const title = oneLine(notice.title, TITLE_MAX);
    params.set(`title`, title === `` ? `Intentic` : title);
    const body = notice.body === undefined ? `` : oneLine(notice.body, BODY_MAX);
    if (body !== ``) {
        params.set(`body`, body);
    }
    if (notice.path !== undefined && PAGE_ROUTE.test(notice.path) && !notice.path.includes(`\\`)) {
        params.set(`path`, notice.path);
    }
    if (notice.silent) {
        params.set(`silent`, `1`);
    }
    return `intentic://notice?${params.toString()}`;
};

export const desktopWithdrawLink = (key: string): string => `intentic://notice?${new URLSearchParams({ do: `withdraw`, key: oneLine(key, KEY_MAX) }).toString()}`;

export const DESKTOP_CLEAR_NOTICES_LINK = `intentic://notice?do=clear`;

/** Puts up one of the system's notifications; nothing outside an app that takes them. */
export const postDesktopNotice = (notice: DesktopNotice): void => {
    if (desktopNotices()) {
        openDesktopLink(desktopNoticeLink(notice));
    }
};

/** Takes down the notification under `key`, which is no longer true. */
export const withdrawDesktopNotice = (key: string): void => {
    if (desktopNotices()) {
        openDesktopLink(desktopWithdrawLink(key));
    }
};

/** Takes down every notification the app put up for this page: the reader is back. */
export const clearDesktopNotices = (): void => {
    if (desktopNotices()) {
        openDesktopLink(DESKTOP_CLEAR_NOTICES_LINK);
    }
};

/* WHETHER THE SYSTEM SHOWS THEM AT ALL (notice.rs `Standing`): a system with notifications switched off drops every one
   without a word, so the page's settings ask, and say where to switch them on. */

/** What the app found: Windows says it of the app (all notifications off, the app's own off, a policy); a Linux desktop
 * only whether a notification service answers. `unknown` until the app has answered. */
export type DesktopNoticeSetting = `on` | `off-user` | `off-app` | `off-policy` | `none` | `unknown`;

const SETTINGS: readonly DesktopNoticeSetting[] = [`on`, `off-user`, `off-app`, `off-policy`, `none`, `unknown`];

export const DESKTOP_NOTICES_EVENT = `intentic-desktop-notices`;

// allow(module-state): what the app last said of this computer's notifications, one answer for the whole page
export const desktopNoticeSetting: Ref<DesktopNoticeSetting> = ref(`unknown`);

/** The app's answer as the page keeps it; anything it does not know is `unknown`. Exported for tests. */
export const receiveDesktopNoticeSetting = (said: string | undefined): void => {
    desktopNoticeSetting.value = SETTINGS.find((setting) => setting === said) ?? `unknown`;
};

let listening = false;

/** Asks the app whether the system shows its notifications; the answer lands in `desktopNoticeSetting`. */
export const askDesktopNoticeSetting = (): void => {
    if (!desktopNotices()) {
        return;
    }
    if (!listening) {
        listening = true;
        window.addEventListener(DESKTOP_NOTICES_EVENT, (event) => {
            // SAFETY: only the app dispatches this event, with `{ setting }` (notice.rs `standing_script`); anything
            // else reads as `unknown` below.
            receiveDesktopNoticeSetting((event as CustomEvent<{ setting?: string } | null>).detail?.setting);
        });
    }
    openDesktopLink(`intentic://notice?do=status`);
};
