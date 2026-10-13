import type { IconName } from "@intentic/ui";
import { formatClock } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import type { WakeListener } from "./useWakeListener";

// Where listening stands, in the reader's words: one reading for the status bar's chip and the Voice settings, so the
// two never say different things about the same microphone.

export type WakeTone = `quiet` | `active` | `warning`;

export interface WakeStatus {
    readonly icon: IconName;
    readonly label: string;
    /** The longer sentence: a tooltip, or the line under the switch. */
    readonly detail: string;
    readonly tone: WakeTone;
    /** What a press on the chip does. */
    readonly press: `pause` | `resume` | `settings` | `none`;
}

type Reading = Pick<WakeListener, `enabled` | `phase` | `mode` | `pausedUntil` | `error` | `word` | `speaking` | `hearing`>;

const failure = (listener: Reading): WakeStatus => {
    const word = listener.word.value;
    switch (listener.error.value) {
        case `mic-blocked`:
            return { icon: `microphone`, label: t(`chat.wake.status.micBlocked`), detail: t(`chat.wake.status.micBlockedDetail`), tone: `warning`, press: `settings` };
        case `no-mic`:
            return { icon: `microphone`, label: t(`chat.wake.status.noMic`), detail: t(`chat.wake.status.noMicDetail`), tone: `warning`, press: `settings` };
        case `needs-rebuild`:
        case `unavailable`:
            return { icon: `microphone`, label: t(`chat.wake.status.cannotHear`), detail: t(`chat.wake.status.cannotHearDetail`, { word }), tone: `warning`, press: `settings` };
        case undefined:
            return { icon: `microphone`, label: t(`chat.wake.status.unsupported`), detail: t(`chat.wake.status.unsupportedDetail`), tone: `warning`, press: `settings` };
    }
};

export const wakeStatus = (listener: Reading, now: number): WakeStatus | undefined => {
    if (!listener.enabled.value) {
        return undefined;
    }
    const word = listener.word.value;
    const paused = listener.pausedUntil.value;
    if (paused !== undefined && paused > now) {
        const until = formatClock(paused);
        return { icon: `pause`, label: t(`chat.wake.status.paused`, { until }), detail: t(`chat.wake.status.pausedDetail`, { word, until }), tone: `quiet`, press: `resume` };
    }
    switch (listener.phase.value) {
        case `off`:
        case `starting`:
            return { icon: `microphone`, label: t(`chat.wake.status.starting`), detail: t(`chat.wake.status.startingDetail`), tone: `quiet`, press: `none` };
        case `elsewhere`:
            return { icon: `microphone`, label: t(`chat.wake.status.elsewhere`), detail: t(`chat.wake.status.elsewhereDetail`, { word }), tone: `quiet`, press: `none` };
        case `blocked`:
            return { icon: `microphone`, label: t(`chat.wake.status.blocked`), detail: t(`chat.wake.status.blockedDetail`, { word }), tone: `warning`, press: `none` };
        case `failed`:
        case `unsupported`:
            return failure(listener);
        case `listening`: {
            const busy = listener.speaking.value || listener.hearing.value > 0 || listener.mode.value !== `wake`;
            const label = listener.mode.value === `wake` ? word : t(`chat.wake.status.goOn`);
            return { icon: `microphone`, label, detail: t(`chat.wake.status.listeningDetail`, { word }), tone: busy ? `active` : `quiet`, press: `pause` };
        }
    }
};
