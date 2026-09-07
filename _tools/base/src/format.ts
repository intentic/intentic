/* HOW BIG IS THIS, in the units whoever is reading actually cares about — a person reading a size, a model
 * paying for a context window. Small, and deliberately small: what belongs here is a measurement or rendering
 * that more than one tier has to produce for the SAME value, where two answers are a bug somebody sees.
 * Anything one surface alone renders belongs next to that surface. */

const SIZE_UNITS = ["B", "KB", "MB", "GB"];

/* A byte count as a short label: `0 B`, `512 B`, `1.4 MB`. Binary units under decimal names, which is what
 * every file manager a user has met does, so a 1,536-byte file reads as `1.5 KB` rather than `1.5 KiB`.
 *
 * Whole bytes, one decimal above: `1.0 KB` carries a precision the reader can use, `1024.0 B` does not, and a
 * byte count is exact so a fraction of one is noise. Caps at GB rather than climbing: past that the number is
 * the story ("this transfer is 4,200 GB") and a unit nobody has intuition for hides it.
 *
 * Shared by the daemon's bundle report and the app's move-out panel because they describe THE SAME bundle —
 * a spool the daemon sized and the panel then re-sized was rounding one number two ways. */
export const sizeLabel = (bytes: number): string => {
    const index = Math.min(SIZE_UNITS.length - 1, bytes === 0 ? 0 : Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${SIZE_UNITS[index]}`;
};

/* A CONSERVATIVE TOKEN COUNT, WITHOUT A TOKENIZER. ~4 chars/token holds for code and prose alike, and it is
 * what every budget in the product is denominated in: iq's render budgets (whose property tests assert the
 * rendered output never exceeds a budget under THIS estimate), fileq's and webq's output caps, and the
 * savings report the daemon computes over the agent output filter.
 *
 * Those numbers are compared to each other — a cleaner's saving is a fraction of a budget, a read that was cut
 * is reported against the cap that cut it — so they have to be the same estimate, and they were four copies of
 * it under three names. Real tokenization is not an option here: it is a model-specific dependency measured in
 * megabytes, on paths that run per file and per frame.
 *
 * `_sandbox/sandbox/bench/cleaner-bench.mjs` keeps its own copy on purpose: it is plain `.mjs` so it can ride
 * the image beside bin/cleaners.mjs with no build step, the split filter-stats.mjs documents. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
