import { t } from "@intentic/ui/i18n";
import { announceDesktopBadge, type DesktopBadgeMark, desktopNotices } from "../../app/environments/desktopNotices";
import { drawPng, iconKey, iconSvg, overlaySvg } from "./tabIcon";
import type { TabMark } from "./tabSignal";

// The tab's mark on the desktop app's own icon (desktop-app badge.rs): the tray's icon, the overlay on the Windows
// taskbar's button and a Linux dock's count. The app's window has no tab, and spends most of its life in the tray, so
// the icon is where the mark can be seen. Both images are the tab icon's own drawing, so the three never disagree.

// The tray draws its icon at 16 pixels on a Windows screen at 100%, 32 at 200%; a Linux panel's is about 22, twice that
// on a dense screen. Each gets the smallest image that stays sharp there.
const traySize = (): number => (/windows/i.test(globalThis.navigator?.userAgent ?? ``) ? 32 : 64);
const OVERLAY_SIZE = 32;

/** What the mark means, beside the app's name in the tray's tooltip. */
export const badgeTooltip = (mark: TabMark | undefined): string | undefined => {
    switch (mark?.kind) {
        case `asks`:
            return t(`shell.browserTab.asksTooltip`, { count: mark.count }, mark.count);
        case `done`:
            return t(`shell.browserTab.doneTooltip`);
        case `working`:
            return t(`shell.browserTab.workingTooltip`);
        case `offline`:
            return t(`shell.browserTab.offlineTooltip`);
        default:
            return undefined;
    }
};

// A PNG data URL as the app takes an image: unpadded URL-safe base64, which rides a link with nothing to escape.
const PNG_PREFIX = `data:image/png;base64,`;
export const linkImage = (dataUrl: string | undefined): string | undefined =>
    dataUrl?.startsWith(PNG_PREFIX) === true ? dataUrl.slice(PNG_PREFIX.length).replaceAll(`+`, `-`).replaceAll(`/`, `_`).replace(/=+$/u, ``) : undefined;

// Which request is the latest, so a slow drawing for an older mark cannot land over a newer one.
let drawing = 0;
let shown: string | undefined;

/** Puts the mark on the desktop app's icon, or takes it off; a mark already up costs nothing. */
export const showDesktopBadge = (mark: TabMark | undefined): void => {
    // Nothing to draw for in a browser, or in an app that takes no badge.
    if (!desktopNotices()) {
        return;
    }
    const tooltip = badgeTooltip(mark);
    // The tooltip carries the count past nine, which the drawing does not.
    const key = `${iconKey(mark) ?? `none`}|${tooltip ?? ``}`;
    if (key === shown) {
        return;
    }
    shown = key;
    drawing += 1;
    const turn = drawing;
    const kind: DesktopBadgeMark = mark?.kind ?? `none`;
    const count = mark?.kind === `asks` ? mark.count : 0;
    if (mark === undefined) {
        announceDesktopBadge({ mark: kind, count });
        return;
    }
    void Promise.all([drawPng(iconSvg(mark), traySize()), drawPng(overlaySvg(mark), OVERLAY_SIZE)]).then(([icon, overlay]) => {
        if (turn !== drawing) {
            return;
        }
        announceDesktopBadge({ mark: kind, count, tooltip, icon: linkImage(icon), overlay: linkImage(overlay) });
    });
};
