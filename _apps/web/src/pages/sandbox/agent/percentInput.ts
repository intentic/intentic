/* The Agent tab holds three percentage boxes — the output holdout and the two turn-level experiments' controls
 * — that are a percentage [0,100] on screen over a fraction [0,1] in settings, so they commit identically.
 *
 * Reading the ELEMENT rather than a plain number is the point: an emptied field is `Number("")`, which is 0 —
 * "measure nothing", saved silently, from a user who was only mid-edit — so it falls back to what is saved
 * instead. The clamped value is written back into the input because the bound value may not have changed
 * (typing 200 over 100), and with nothing for Vue to patch the box would keep showing the number that was
 * refused. */
export const commitPercent = (event: Event, saved: number, apply: (fraction: number) => void): void => {
    const input = event.target as HTMLInputElement;
    const typed = Number(input.value);
    const percent = input.value === `` || !Number.isFinite(typed) ? saved : Math.min(100, Math.max(0, Math.round(typed)));
    input.value = String(percent);
    apply(percent / 100);
};

// The saved fraction as the whole percent the box shows.
export const asPercent = (fraction: number | undefined): number => Math.round((fraction ?? 0) * 100);
