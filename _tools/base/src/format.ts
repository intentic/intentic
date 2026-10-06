// Measurements or renderings more than one tier must produce identically for the same value (a size, a token budget); a
// mismatch there is a visible bug. Anything one surface alone renders belongs next to that surface.

const SIZE_UNITS = ["B", "KB", "MB", "GB"];

// Byte count as a short label (0 B, 1.4 MB), binary units under decimal names, like a file manager; capped at GB.
// English and fixed, for the daemon and the CLIs: a screen with a reader's language says it with the UI kit's
// formatBytes instead (_tools/checks/format-tiers.mjs).
export const sizeLabel = (bytes: number): string => {
    const index = Math.min(SIZE_UNITS.length - 1, bytes === 0 ? 0 : Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${SIZE_UNITS[index]}`;
};

// ~4 chars/token, no tokenizer: every budget in the product (iq's render budgets, fileq/webq's caps, the daemon's
// savings report, its context and handoff budgets, the privacy gateway's result clearing) is the same estimate, rounded
// up, so they agree. cleaner-bench.mjs keeps its own copy, build-step-free.
export const CHARS_PER_TOKEN = 4;
export const tokensOfChars = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);
export const estimateTokens = (text: string): number => tokensOfChars(text.length);
// The characters a budget of `tokens` holds, by the same rate.
export const charsOfTokens = (tokens: number): number => tokens * CHARS_PER_TOKEN;

// "1 file" / "3 files"; sibilant endings (s, x, z, ch, sh) get -es. Pass `many` for irregular plurals ("advisory" →
// "advisories") where the suffix rule cannot reach.
export const plural = (count: number, one: string, many?: string): string =>
    `${count} ${count === 1 ? one : (many ?? (/(s|x|z|ch|sh)$/.test(one) ? `${one}es` : `${one}s`))}`;

const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Replaces the five characters that are active in HTML text and attribute contexts; safe for both template-literal HTML
// and v-html injection.
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);

// Constrains a value to [min, max]; used everywhere a pixel, percentage, or index must stay in bounds.
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

// A span in the fewest characters: seconds under two minutes, whole minutes above, for the daemon's watch wording. The
// editor says the same span with the UI kit's formatElapsed, in the reader's language (_tools/checks/format-tiers.mjs).
export const briefDuration = (seconds: number): string => (seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`);
