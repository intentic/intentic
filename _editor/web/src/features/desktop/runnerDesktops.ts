import type { RunnerOpenViewInput } from "@intentic/sandbox-contract/schemas/runner-views";
import type { DesktopState, DesktopWindow, SystemDesktop } from "@intentic/sandbox-contract/schemas/terminal";
import { socketUrl } from "../../client/sandbox/streams/wsTicket";
import { runnerSocketUrl } from "../../models/runners/runnerViews";
import { rosterConversationOn } from "../../models/placement/runnerPlacement";
import type { PinnedTab } from "../../workbench/browsers/browsersPaths";

// THE DESKTOPS THE BROWSERS VIEW OFFERS: this sandbox's own, and each connected runner's (`system.desktop().runners`), for
// the conversations that run there. A runner's picture opens through `runners.openView` (`desktop-view`), asked through
// a conversation placed on that runner, with a fresh ticket for every dial; this sandbox's own on /system/desktop-view.

/** Which desktop a view is of: one window on it by id, or the whole display; a runner's, or this sandbox's. */
export interface DesktopAt {
    readonly window?: string | undefined;
    readonly runner?: string | undefined;
}

/** What a desktop socket dials through; a test's to replace. */
export interface DesktopSocketSeams {
    readonly local: (path: string, extra?: Record<string, string>) => Promise<string | undefined>;
    readonly runnerUrl: (input: RunnerOpenViewInput) => Promise<string | undefined>;
    readonly conversationOn: (runner: string) => string | undefined;
}

const SEAMS: DesktopSocketSeams = { local: socketUrl, runnerUrl: (input) => runnerSocketUrl(input), conversationOn: rosterConversationOn };

const VIEW = `/system/desktop-view`;

/**
 * Where a desktop view's socket dials, asked at every dial. A runner's with no conversation placed on it to ask through
 * has nowhere to dial (undefined), as an unreachable sandbox has not.
 */
export const desktopSocketUrl = async (at: DesktopAt, seams: DesktopSocketSeams = SEAMS): Promise<string | undefined> => {
    if (at.runner === undefined) {
        return at.window === undefined ? seams.local(VIEW) : seams.local(VIEW, { window: at.window });
    }
    const conversationId = seams.conversationOn(at.runner);
    if (conversationId === undefined) {
        return undefined;
    }
    const input: RunnerOpenViewInput = { conversationId, kind: `desktop-view` };
    if (at.window !== undefined) {
        input.session = at.window;
    }
    return seams.runnerUrl(input);
};

/** The state of the desktop a view is of: this sandbox's own, or the runner's as this sandbox last heard it. */
export const desktopStateOf = (state: SystemDesktop | undefined, runner: string | undefined): DesktopState | undefined =>
    runner === undefined ? state : state?.runners?.find((entry) => entry.runner === runner)?.state;

/** One window on a desktop, by id. */
export const deskWindowOf = (state: SystemDesktop | undefined, id: string, runner?: string): DesktopWindow | undefined =>
    desktopStateOf(state, runner)?.list?.find((entry) => entry.id === id);

/** How a window is named on its tab and in its address: its title, else its program. */
export const windowLabel = (entry: DesktopWindow | undefined, id: string): string => entry?.title || entry?.app || id;
export const appAddress = (entry: DesktopWindow | undefined, id: string): string =>
    `app://${(entry?.app ?? id).toLowerCase().replaceAll(/[^a-z0-9.-]+/gu, `-`)}`;
const DESKTOP_ADDRESS = `desktop://`;

/** A desktop's own address: a runner's names it, so two desktops never read alike. */
export const desktopAddress = (runner: string | undefined): string => (runner === undefined ? DESKTOP_ADDRESS : `${DESKTOP_ADDRESS}${runner}`);

/** What the launcher offers to open: each desktop, then each window on it, this sandbox's first, then each runner's. */
export interface DeskEntry {
    readonly tab: Extract<PinnedTab, { kind: `desktop` | `app` }>;
    readonly label: string;
    readonly detail: string;
    readonly icon: `screen` | `window-maximize`;
}

export const deskEntries = (state: SystemDesktop | undefined, desktopLabel: (runner: string | undefined) => string): readonly DeskEntry[] => {
    const one = (runner: string | undefined, windows: readonly DesktopWindow[]): DeskEntry[] => [
        { tab: { kind: `desktop`, runner }, label: desktopLabel(runner), detail: desktopAddress(runner), icon: `screen` },
        ...windows.map((entry): DeskEntry => ({
            tab: { kind: `app`, id: entry.id, runner },
            label: windowLabel(entry, entry.id),
            detail: appAddress(entry, entry.id),
            icon: `window-maximize`,
        })),
    ];
    return [...one(undefined, state?.list ?? []), ...(state?.runners ?? []).flatMap((entry) => one(entry.runner, entry.state.list ?? []))];
};
