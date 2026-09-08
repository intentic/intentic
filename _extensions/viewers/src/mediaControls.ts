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

// Formats seconds as a clock, omitting the hours field under an hour. Infinity or NaN render as `--:--`, not `0:00`.
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
