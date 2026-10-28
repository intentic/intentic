import type { TerminalClientMessage } from "@intentic/sandbox-contract/browser-wire";
import { onScreen } from "../../workbench/window/onScreen";
import type { Grid } from "./terminalSizing";

// Whether a viewport is showing its pane, as the daemon is told. Every viewer of a session shares one grid, the smallest
// that fits each viewer showing the pane (netd term/hub.rs). A viewer out of sight says it is away and bounds nothing.
// Before this, a panel left docked at its default 13 rows in a background tab held the pane at 13 rows in every other
// window, however tall.

export type TerminalPresence = {
    readonly host: HTMLElement;
    requestedGrid: Grid;
    // What the daemon was last told: away, or showing the pane at `requestedGrid`. Nothing told yet reads as away, as
    // a socket opened before its first mount attaches.
    away?: boolean;
};

// In a document, laid out at a size, in a window the person can see. A host in a popped-out window answers for that
// window. The app's own window also takes the desktop app's word, which knows a window hidden in the tray.
export const showsPane = (host: HTMLElement): boolean => {
    const view = host.ownerDocument;
    return (
        host.isConnected &&
        host.clientWidth > 0 &&
        host.clientHeight > 0 &&
        view.visibilityState === `visible` &&
        (view !== document || onScreen.value)
    );
};

// The viewport's report, always made: a remounted viewport restates its capacity even when its size is unchanged.
export const presenceReport = (p: TerminalPresence): TerminalClientMessage => {
    p.away = !showsPane(p.host);
    return p.away ? { type: `away` } : { type: `resize`, ...p.requestedGrid };
};

// The report only when the viewport has come into or gone out of sight. A size change in sight is the debounced resize's.
export const presenceChange = (p: TerminalPresence): TerminalClientMessage | undefined =>
    showsPane(p.host) === (p.away ?? true) ? presenceReport(p) : undefined;
