import type { InjectionKey } from "vue";
import { osScreenAllow, osScreenStatus, type OsScreenStatus } from "../../../osSettings";

// SANDBOX WINDOWS, on This computer when it runs Intentic OS with a screen: which of this computer's sandboxes may open
// windows of their own on it. Every one is off until the owner turns it on here; ic's screen service (`ic os screen`)
// holds the rest (an amber frame and the sandbox's name on every such window, never fullscreen, closed when turned off).

export interface ScreenActions {
    readonly status: () => Promise<OsScreenStatus | null>;
    readonly allow: (slug: string, allowed: boolean) => Promise<OsScreenStatus | null>;
}

/** The card's one seam: a preview or test supplies it without making a web page look like a Tauri window. */
export const SCREEN_ACTIONS: InjectionKey<ScreenActions> = Symbol(`sandbox windows`);
export const screenActions: ScreenActions = { status: osScreenStatus, allow: osScreenAllow };

/** One switch on the card: a sandbox by the name the app knows it by, else its slug. */
export interface WindowRow {
    readonly slug: string;
    readonly name: string;
    readonly allowed: boolean;
    /** Allowed, running, and the screen service has its socket open: it can draw now. */
    readonly drawing: boolean;
}

/** Every sandbox ic lists, named and in name order. Pure. */
export const windowRowsOf = (
    status: OsScreenStatus,
    sandboxes: readonly { readonly slug: string; readonly name?: string | undefined }[],
): readonly WindowRow[] => {
    const names = new Map(sandboxes.map((sandbox) => [sandbox.slug, sandbox.name?.trim()]));
    return status.sandboxes
        .map((row) => ({ slug: row.slug, name: names.get(row.slug) || row.slug, allowed: row.allowed, drawing: row.allowed && row.socket }))
        .sort((one, other) => one.name.localeCompare(other.name));
};
