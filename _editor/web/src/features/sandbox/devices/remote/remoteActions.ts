import { page } from "@intentic/sandbox-contract/app-routes";
import type { Router } from "vue-router";
import { here } from "../../../../lib/routes/links";
import type { RemoteApi } from "../../../../models/sandbox/devices/remote/remoteApi";
import { holdDeviceTerminal } from "../../../../models/terminal/deviceTerminals";
import { useTerminalPanel } from "../../../../models/terminal/useTerminalPanel";

// WHAT THE DEVICE PAGE'S TERMINAL BUTTONS DO: a shell opened on the computer (or one already running there, attached)
// becomes a tab of the terminal panel (models/terminal/deviceTerminals.ts) and is brought to front, docked on a desktop
// and on its own screen on a phone.

// The grid a new shell starts at, before the panel's first fit tells the computer the real one.
const START_GRID = { cols: 120, rows: 32 };

export interface TerminalAt {
    // The connection whose remoted serves it (`rog`, `rog::wsl:archlinux`).
    readonly device: string;
    // Where on the computer it runs, for the tab: the connection's own environment (remoteOffers.ts `RemoteSide`).
    readonly environment: string;
    // The tab's title: the computer, then where on it.
    readonly title: string;
}

// Brings the panel up on the tab: docked on a desktop; the terminal's own screen on a phone, which has no dock.
const show = (name: string, title: string, mobile: boolean, router: Router): void => {
    useTerminalPanel().openFocused(name, { title });
    if (mobile) {
        void router.push(here(page.terminal()));
    }
};

/**
 * Opens a new shell on the computer as a tab, in the connection's own environment: asked for no environment, the
 * connection's own remoted opens its own shell, a distro's a native Linux one. Rejects with the sandbox's sentence.
 */
export const openDeviceTerminal = async (at: TerminalAt, api: RemoteApi, mobile: boolean, router: Router): Promise<void> => {
    const grant = await api.openTerminal({ device: at.device, ...START_GRID });
    const held = holdDeviceTerminal({ device: at.device, session: grant.session, title: at.title, environment: at.environment }, grant);
    show(held.name, held.title, mobile, router);
};

/** Attaches to a shell already running on the computer, as a tab; its first dial asks the sandbox for a token. */
export const attachDeviceTerminal = (at: TerminalAt & { readonly session: string }, mobile: boolean, router: Router): void => {
    const held = holdDeviceTerminal(at);
    show(held.name, held.title, mobile, router);
};
