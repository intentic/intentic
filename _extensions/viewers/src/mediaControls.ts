import type { IconName } from "@intentic/extension-ui";

// Pure, unit-testable helpers extracted from MediaViewer: functions of a number or keystroke, not lifecycle.

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
