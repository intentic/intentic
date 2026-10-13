import { t } from "@intentic/ui/i18n";
import { shallowRef } from "vue";
import { hold, type NotificationInput, useNotifications } from "../../../workbench/notifications/notifications";
import { type SpeechPlayer, type SpeechPlayerState, useSpeechPlayer } from "./speechPlayer";

// The Read aloud press (ChatReadAloud) and what it tells the person while it works. The press itself only has room for a
// glyph, and the wait before the first word can be long (a voice downloading the first time, a sentence made on the
// box's CPU), so the stage is said in words on a card in the notification lane, with Stop on it for when the reply has
// scrolled away. A read that fails says why; a stop says nothing, since the person asked for it.

/** What is being read: the player's key for it, and how the reply begins, to say which one. */
export interface Reading {
    readonly key: string;
    readonly excerpt: string;
}

// allow(module-state): the page's one player reads one reply at a time, so what it reads is the page's too
const reading = shallowRef<Reading | undefined>();

const EXCERPT_CHARS = 72;

/** How a reply begins, as plain words: its first line of prose, markdown and code fences left out. */
export const excerptOf = (text: string): string => {
    const prose = text.replace(/```[\s\S]*?(```|$)/g, `\n`);
    const line =
        prose
            .split(`\n`)
            .map((candidate) =>
                candidate
                    .replace(/^\s*(?:[#>]+|[-*+]|\d+[.)])\s+/, ``)
                    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, `$1`)
                    .replace(/[*_`~]/g, ``)
                    .replace(/\s+/g, ` `)
                    .trim(),
            )
            .find((candidate) => candidate !== ``) ?? ``;
    return line.length <= EXCERPT_CHARS ? line : `${line.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`;
};

/** The slice of the player the card is drawn from. */
export interface ReadAloudView {
    readonly state: SpeechPlayerState;
    readonly speaking: string | undefined;
    readonly progress: number | undefined;
    readonly notice: string | undefined;
}

/** The lane's card while a reply is read aloud, or undefined when none is (or the voice is saying something else). */
export const readAloudNotice = (view: ReadAloudView, read: Reading | undefined, stop: () => void): NotificationInput | undefined => {
    if (read === undefined || view.speaking !== read.key || view.state === `idle`) {
        return undefined;
    }
    const which = read.excerpt === `` ? undefined : `“${read.excerpt}”`;
    const actions = [{ label: t(`ui.action.stop`), run: stop }];
    if (view.state === `speaking`) {
        // A notice while it speaks is a provider that failed over: still reading, in another voice, which is worth saying.
        return { kind: `condition`, tone: `info`, icon: `volume-up`, title: t(`chat.readAloud.reading`), detail: view.notice ?? which, actions };
    }
    if (view.state === `downloading`) {
        return {
            kind: `condition`,
            tone: `info`,
            icon: `spinner`,
            spin: true,
            title: t(`chat.readAloud.downloading`, { percent: Math.round((view.progress ?? 0) * 100) }),
            detail: t(`chat.readAloud.downloadOnce`),
            actions,
        };
    }
    return { kind: `condition`, tone: `info`, icon: `spinner`, spin: true, title: t(`chat.readAloud.preparing`), detail: which, actions };
};

/** Reads `text` aloud as the reply `key`; a failure is reported in the lane with the player's reason. */
export const readAloud = async (text: string, key: string, player: SpeechPlayer = useSpeechPlayer()): Promise<void> => {
    reading.value = { key, excerpt: excerptOf(text) };
    const end = await player.say(text, { key, as: `read`, lang: navigator.language });
    if (reading.value?.key === key) {
        reading.value = undefined;
    }
    if (end === `failed`) {
        useNotifications().report({ tone: `problem`, title: t(`chat.readAloud.failed`), detail: player.notice.value });
    }
};

/** Puts the read-aloud card in the lane; registered once, from the root (notificationSources). */
export const holdReadAloudNotice = (player: SpeechPlayer = useSpeechPlayer()): (() => void) =>
    hold(`read-aloud`, () =>
        readAloudNotice(
            { state: player.state.value, speaking: player.speaking.value, progress: player.progress.value, notice: player.notice.value },
            reading.value,
            player.stop,
        ),
    );
