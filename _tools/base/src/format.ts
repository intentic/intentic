// Measurements or renderings more than one tier must produce identically for the same value (a size, a token budget); a
// mismatch there is a visible bug. Anything one surface alone renders belongs next to that surface.

const SIZE_UNITS = ["B", "KB", "MB", "GB"];

// Byte count as a short label (0 B, 1.4 MB), binary units under decimal names, like a file manager; capped at GB.
// Shared by the daemon's bundle report and the app's move-out panel, which describe the same bundle.
export const sizeLabel = (bytes: number): string => {
    const index = Math.min(SIZE_UNITS.length - 1, bytes === 0 ? 0 : Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${SIZE_UNITS[index]}`;
};

// ~4 chars/token, no tokenizer: every budget in the product (iq's render budgets, fileq/webq's caps, the daemon's
// savings report) is the same estimate, so they agree. cleaner-bench.mjs keeps its own copy, build-step-free.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
