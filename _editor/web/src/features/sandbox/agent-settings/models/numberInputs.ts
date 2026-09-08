// Both commit functions read the input element, not a bound number, and fall back to `saved` when the field is empty or
// unparsable, since `Number("")` is 0 and would silently commit a false zero. The clamped value is written back to the
// input, since Vue won't repaint the box if the bound value didn't change.

// Percent on screen, fraction [0,1] in settings; used by the output holdout and the two turn-level experiment controls.
export const commitPercent = (event: Event, saved: number, apply: (fraction: number) => void): void => {
    const input = event.target as HTMLInputElement;
    const typed = Number(input.value);
    const percent = input.value === `` || !Number.isFinite(typed) ? saved : Math.min(100, Math.max(0, Math.round(typed)));
    input.value = String(percent);
    apply(percent / 100);
};

// The saved fraction as the whole percent the box shows.
export const asPercent = (fraction: number | undefined): number => Math.round((fraction ?? 0) * 100);

// Whole number with caller-supplied bounds (the subagent caps); the daemon owns the schema and rejects anything outside
// them, so this box must not accept what a save would refuse.
export const commitCount = (
    event: Event,
    saved: number,
    bounds: { readonly min: number; readonly max: number },
    apply: (value: number) => void,
): void => {
    const input = event.target as HTMLInputElement;
    const typed = Number(input.value);
    const count = input.value === `` || !Number.isFinite(typed) ? saved : Math.min(bounds.max, Math.max(bounds.min, Math.round(typed)));
    input.value = String(count);
    apply(count);
};
