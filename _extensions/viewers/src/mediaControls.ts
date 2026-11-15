import type { IconName } from "@intentic/extension-ui";
import { onBeforeUnmount, ref } from "vue";

// Helpers extracted from MediaViewer: pure functions of a number or keystroke, testable alone, and the one piece of
// lifecycle the player hands off (useRendition, at the end).

// Playback-rate ladder shared by the speed menu and the `,`/`.` shortcuts, so both agree on one step.
export const SPEEDS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// Seek key to seconds map; arrows nudge, J/L take a bigger step. Uppercase included for Shift.
export const seekTargets: Readonly<Record<string, number>> = {
    ArrowLeft: -5,
    ArrowRight: 5,
    j: -10,
    J: -10,
    l: 10,
    L: 10,
};

// The address of a recording rendered for any browser (GET /workspace/media's `playable`), for a player whose element
// couldn't decode the file itself. Only a streamed address has one: a blob: URL is bytes this page already holds, and an
// address already asking for the rendition has nothing further to ask for.
export const playableSource = (src: string): string | undefined =>
    /\/workspace\/media\?/.test(src) && !/[?&]playable=/.test(src) ? `${src}&playable=1` : undefined;

// Seconds between asks where the daemon names none.
const DEFAULT_RETRY_S = 2;

// A pause that ends early on an abort, as @intentic/base's sleep does (this bundle carries only the extension kit), so a
// player closed mid-wait holds no timer.
const pauseFor = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((done) => {
        const timer = setTimeout(done, ms);
        const stop = (): void => {
            clearTimeout(timer);
            done();
        };
        signal.addEventListener(`abort`, stop, { once: true });
    });

// How the wait reaches the daemon and the clock; the defaults are the browser's fetch and the pause above. Replaced in
// tests, which count asks and pauses rather than make them.
export interface RenditionAsk {
    readonly ask?: (url: string, init: RequestInit) => Promise<Response>;
    readonly pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Whether the rendition at `url` is ready to stream, asking until the daemon stops answering that it is still being made
// (503): a video can take minutes to re-encode, longer than any proxy holds one request open, so the daemon answers each
// ask after a bounded wait and the player asks again. One byte at a time, so a finished rendition costs nothing to
// confirm. False when it can't be made (415), the file is gone, the network failed, or the player moved on (`signal`).
export const renditionReady = async (
    url: string,
    signal: AbortSignal,
    { ask = (target, init) => fetch(target, init), pause = pauseFor }: RenditionAsk = {},
): Promise<boolean> => {
    while (!signal.aborted) {
        let answer: Response;
        try {
            answer = await ask(url, { headers: { Range: `bytes=0-0` }, cache: `no-store`, signal });
        } catch {
            // allow(silent-catch): a rendition the network can't reach is one the player can't play, which false says
            return false;
        }
        // The byte itself is not wanted; letting the body go frees the connection.
        // allow(silent-catch): a body already gone has nothing left to let go of
        await answer.body?.cancel().catch(() => undefined);
        if (answer.status !== 503) {
            return answer.ok;
        }
        const after = Number(answer.headers.get(`retry-after`));
        await pause((Number.isFinite(after) && after > 0 ? after : DEFAULT_RETRY_S) * 1000, signal);
    }
    return false;
};

// The transport's buttons, in row order: one shape, so the row is a list rather than nine copies of it. `press` is bound
// with `v-action`, which locks the button for as long as an async toggle runs and no-ops on a sync one.
export interface Transport {
    readonly key: string;
    readonly icon: IconName;
    /** Screen-reader name; the tooltip carries the keyboard shortcut instead. */
    readonly label: string;
    /** A word or two, and the shortcut as a key cap (v-tooltip's `Tip`) when there is one. */
    readonly hint: string | { readonly title: string; readonly keys: string };
    readonly active?: boolean;
    // An async toggle hands back its promise, which `v-action` holds the button for; `void` admits both.
    readonly press: () => void;
}

// The shortcuts MediaViewer's key handler answers, as the key caps the tooltips draw.
export const KEYS = { play: `K`, back: `J`, forward: `L`, mute: `M`, pip: `P`, fullscreen: `F`, speed: `, .` } as const;

// What the player's element plays: `src`, or once that failed to decode, the daemon's rendering of it (AAC for a
// recording, H.264 for a video), spun over while it's made; only that failing too is a failure. The rendering is handed
// to the element once the daemon says it is ready (renditionReady above), since a video takes longer to make than one request
// is held open. The wait is let go when the file changes (`reset`) or the player closes.
export const useRendition = (src: () => string) => {
    const source = ref(src());
    const rendering = ref(false);
    const failed = ref(false);
    let wait: AbortController | undefined;

    // The element's `error`: the file, or its rendering, would not decode.
    const onError = async (): Promise<void> => {
        wait?.abort();
        const mine = (wait = new AbortController());
        const next = playableSource(source.value);
        rendering.value = next !== undefined;
        const ready = next !== undefined && (await renditionReady(next, mine.signal));
        if (!mine.signal.aborted) {
            rendering.value = ready;
            failed.value = !ready;
            source.value = ready ? next : source.value;
        }
    };

    // A new file: its own address, nothing asked for yet.
    const reset = (): void => {
        wait?.abort();
        source.value = src();
        rendering.value = false;
        failed.value = false;
    };

    onBeforeUnmount(() => wait?.abort());
    return { source, rendering, failed, onError, reset };
};
