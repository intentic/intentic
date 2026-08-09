/* The Agent tab's numeric boxes, committed the same way — because the trap they share is the EMPTY FIELD.
 * `Number("")` is 0, so a user who selects the contents and pauses before typing has silently saved "measure
 * nothing" or "one subagent". Both committers therefore read the ELEMENT, not a bound number, and fall back to
 * what is saved when the box holds nothing usable.
 *
 * The clamped value is written back into the input because the bound value may not have changed (typing 200
 * over 100), and with nothing for Vue to patch the box would keep showing the number that was refused. */

// A percentage [0,100] on screen over a fraction [0,1] in settings — the output holdout and the two turn-level
// experiments' controls.
export const commitPercent = (event: Event, saved: number, apply: (fraction: number) => void): void => {
    const input = event.target as HTMLInputElement;
    const typed = Number(input.value);
    const percent = input.value === `` || !Number.isFinite(typed) ? saved : Math.min(100, Math.max(0, Math.round(typed)));
    input.value = String(percent);
    apply(percent / 100);
};

// The saved fraction as the whole percent the box shows.
export const asPercent = (fraction: number | undefined): number => Math.round((fraction ?? 0) * 100);

// A plain whole number with its own floor and ceiling — the subagent caps. The bounds are the schema's, passed
// in rather than looked up here: the daemon rejects anything outside them, and a box that lets you type a number
// the save will refuse is a box that appears to have taken your answer.
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
