import { watch } from "vue";
import { z } from "zod";
import { desktopApp, openDesktopLink } from "../../../app/environments/desktop";
import { onScreen } from "../../../workbench/window/onScreen";
import type { WakeListener } from "./useWakeListener";

// The wake listener inside the desktop app, which keeps the workspace loaded in its tray and so is where listening lives
// longest. The page tells the app where listening stands (`intentic://wake`), for the tray's rows and for whether to
// load the workspace hidden at the next launch; the app tells the page what its tray was pressed for (the
// `intentic-desktop-wake` event). Like every link to the app, a navigation it intercepts, never IPC.

export const DESKTOP_WAKE_EVENT = `intentic-desktop-wake`;

/** Where listening stands, in the app's words (the tray reads `off`, `listening`, `paused`, `blocked`, `error`). */
export type DesktopWakeState = `off` | `listening` | `paused` | `blocked` | `error`;

// A microphone still opening while the window is off screen is one the app's Linux webview holds until the window is
// shown once (WebKitGTK answers getUserMedia only then), so the tray offers the press that shows it: `blocked`.
export const desktopWakeState = (listener: Pick<WakeListener, `enabled` | `phase` | `pausedUntil`>, now: number, shown = true): DesktopWakeState => {
    if (!listener.enabled.value) {
        return `off`;
    }
    if (listener.pausedUntil.value !== undefined && listener.pausedUntil.value > now) {
        return `paused`;
    }
    switch (listener.phase.value) {
        case `blocked`:
            return `blocked`;
        case `starting`:
            return shown ? `listening` : `blocked`;
        case `failed`:
        case `unsupported`:
            return `error`;
        default:
            return `listening`;
    }
};

// One line, bounded, no control characters: what the app holds a value to before it takes the link.
const CONTROL = /\p{Cc}/gu;

export const desktopWakeLink = (state: DesktopWakeState, word: string, until: number | undefined): string => {
    const params = new URLSearchParams({ state, word: Array.from(word.replace(CONTROL, ` `).trim()).slice(0, 40).join(``) });
    if (state === `paused` && until !== undefined) {
        params.set(`until`, String(Math.round(until)));
    }
    return `intentic://wake?${params.toString()}`;
};

/** What the tray asks of the page: switch listening on or off, pause it for a while, or bring it back. */
export const DesktopWakeAskSchema = z.object({
    do: z.enum([`on`, `off`, `pause`, `resume`]),
    minutes: z
        .number()
        .positive()
        .max(24 * 60)
        .optional(),
});
export type DesktopWakeAsk = z.infer<typeof DesktopWakeAskSchema>;

/** Starts telling the app about listening and taking its tray's asks; nothing outside an app that listens. */
/** The slice of the listener the bridge reads and drives. */
export type DesktopWakeListener = Pick<WakeListener, `enabled` | `phase` | `pausedUntil` | `word` | `setEnabled` | `pause` | `resume`>;

export const startWakeDesktop = (listener: DesktopWakeListener): (() => void) => {
    if (desktopApp()?.wake !== true) {
        return () => {};
    }
    let told: string | undefined;
    const stopTelling = watch(
        () => desktopWakeLink(desktopWakeState(listener, Date.now(), onScreen.value), listener.word.value, listener.pausedUntil.value),
        (link) => {
            if (link !== told) {
                told = link;
                openDesktopLink(link);
            }
        },
        { immediate: true },
    );
    // The app says each ask again every few seconds until this page reports a state that agrees with it, so an ask that
    // is already true changes nothing: a repeated pause must not push its end along, a repeated `on` not end a pause.
    const asked = (event: Event): void => {
        const parsed = DesktopWakeAskSchema.safeParse(event instanceof CustomEvent ? event.detail : undefined);
        const ask = parsed.success ? parsed.data : undefined;
        const paused = listener.pausedUntil.value !== undefined && listener.pausedUntil.value > Date.now();
        switch (ask?.do) {
            case `on`:
                if (!listener.enabled.value || paused) {
                    listener.setEnabled(true);
                }
                return;
            case `off`:
                if (listener.enabled.value) {
                    listener.setEnabled(false);
                }
                return;
            case `pause`:
                if (listener.enabled.value && !paused) {
                    listener.pause(ask.minutes ?? 60);
                }
                return;
            case `resume`:
                if (paused) {
                    listener.resume();
                }
                return;
            case undefined:
                return;
        }
    };
    window.addEventListener(DESKTOP_WAKE_EVENT, asked);
    return () => {
        stopTelling();
        window.removeEventListener(DESKTOP_WAKE_EVENT, asked);
    };
};
