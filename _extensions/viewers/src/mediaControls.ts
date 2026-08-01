/* The player's pure parts — the bits of MediaViewer that are a function of a number or a keystroke and have no
 * business being inside a component. Unit-testable, and the reason the .vue file is all lifecycle. */

// The playback-rate ladder, shared by the speed menu and the `,`/`.` shortcuts so the two can never disagree
// about what "one step slower" means. Half to double, the range where speech stays intelligible.
export const SPEEDS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/* Seek keys → seconds. The pairing every player has taught people: arrows nudge, J/L take the bigger step
 * (YouTube's), and both directions come from one table so they cannot drift apart. Upper case included
 * because Shift is a plausible thing to be holding.
 */
export const seekTargets: Readonly<Record<string, number>> = {
    ArrowLeft: -5,
    ArrowRight: 5,
    j: -10,
    J: -10,
    l: 10,
    L: 10,
};

/* Seconds → a clock. Drops the hours field for anything under an hour (a 90-second clip reading "0:01:30" is
 * padding, not precision) and keeps the fields aligned within a file, since the total is formatted the same
 * way and sits right beside the elapsed.
 *
 * A stream whose duration the container never declared arrives here as Infinity or NaN — the honest render of
 * that is a dash, not "0:00", which would claim the file is empty. */
const pad = (value: number): string => String(value).padStart(2, `0`);

export const formatDuration = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return `--:--`;
    }
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
};
