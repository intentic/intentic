// The desktop app's reports on an install it runs for this page, as the setup screen reads them. A report crosses a
// process boundary, so nothing in it is taken on trust: a field out of shape is dropped, a report out of shape is nothing.

import { z } from "zod";

/* THE APP ANNOUNCING WHERE THE INSTALL IT IS RUNNING HAS GOT TO (desktop-app's windows.rs `announce_setup`). */
export const DESKTOP_SETUP_EVENT = `intentic-desktop-setup`;

export type DesktopSetupState = `running` | `waiting` | `failed` | `stopped` | `done` | `closed`;
/** What a waiting setup waits for: the reader's go-ahead on the app's card, Windows ending the session, or this PC's own
 * setup (Docker, WSL: the app's onboarding), after which the handed-over setup carries on by itself. */
export type DesktopSetupWaitingFor = `consent` | `restart` | `signOut` | `pcSetup`;

export interface DesktopSetupReport {
    /// The sandbox's name, as the user typed it.
    readonly name?: string;
    readonly state: DesktopSetupState;
    /// 0–100, the app's own weighted bar.
    readonly percent: number;
    /// "Step 4 of 10".
    readonly position?: string;
    /// "about 3 min left".
    readonly remaining?: string;
    /// The running step's phase id, for analytics rather than the screen.
    readonly step?: string;
    /// On `waiting`: what the app's card asks (commands.rs `SetupReport`). Absent from an older app.
    readonly waitingFor?: DesktopSetupWaitingFor;
    /// On `waiting`: the requirement ids on the card, for analytics rather than the screen.
    readonly requirements?: readonly string[];
    /// When the app sent this report, ms since the epoch. Only an app that heartbeats says it: one that re-sends its
    /// report at least every five seconds while it runs or waits, so silence from it means something. An app without it
    /// (v1.331.0 and older) reports only on a change, and a download that outruns its estimate changes nothing for minutes.
    readonly at?: number;
    /// During `pulling-image`, when known: bytes of the sandbox image downloaded so far, and in all.
    readonly downloaded?: number;
    readonly downloadTotal?: number;
    /// The estimate behind `remaining`, in seconds: for this page's own words and decisions, `remaining` being the app's.
    readonly remainingSeconds?: number;
}

const WAITING_FOR: readonly DesktopSetupWaitingFor[] = [`consent`, `restart`, `signOut`, `pcSetup`];

const SETUP_STATES: readonly DesktopSetupState[] = [`running`, `waiting`, `failed`, `stopped`, `done`, `closed`];

// The report's counts and clocks, each a real amount or nothing: a negative or a NaN would read as "-1 of NaN GB". An
// older app sends none of them.
const amount = z.number().nonnegative().optional().catch(undefined);
const SetupAmountsSchema = z.object({ at: amount, downloaded: amount, downloadTotal: amount, remainingSeconds: amount });

/* The event's detail read back as a report, or nothing. */
export const readDesktopSetupReport = (detail: unknown): DesktopSetupReport | undefined => {
    if (detail === null || typeof detail !== `object`) {
        return undefined;
    }
    const raw = detail as Record<string, unknown>;
    const state = SETUP_STATES.find((known) => known === raw[`state`]);
    if (state === undefined || typeof raw[`percent`] !== `number` || !Number.isFinite(raw[`percent`])) {
        return undefined;
    }
    const text = (key: string): string | undefined => (typeof raw[key] === `string` && raw[key] !== `` ? (raw[key] as string) : undefined);
    const name = text(`name`);
    const position = text(`position`);
    const remaining = text(`remaining`);
    const step = text(`step`);
    const waitingFor = WAITING_FOR.find((known) => known === raw[`waitingFor`]);
    const requirements = Array.isArray(raw[`requirements`])
        ? (raw[`requirements`] as unknown[]).filter((id): id is string => typeof id === `string` && /^[a-z0-9-]{1,40}$/.test(id))
        : undefined;
    return {
        state,
        percent: Math.min(100, Math.max(0, raw[`percent`])),
        ...(name === undefined ? {} : { name }),
        ...(position === undefined ? {} : { position }),
        ...(remaining === undefined ? {} : { remaining }),
        ...(step === undefined ? {} : { step }),
        ...(waitingFor === undefined ? {} : { waitingFor }),
        ...(requirements === undefined ? {} : { requirements }),
        ...SetupAmountsSchema.parse(raw),
    };
};
