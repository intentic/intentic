import { computed, type ComputedRef, type Ref } from "vue";
import { definePreference } from "./preference.js";

/**
 * One rung of the text size ladder, smallest first. The three Settings names (Compact, Comfortable, Large: 100, 110 and
 * 120%) keep the words they were stored under before the ladder existed, so a stored choice and an older window still
 * read them; the rungs a zoom key reaches beyond those are their percentage.
 */
export const TEXT_SIZES = [`90`, `compact`, `default`, `large`, `135`, `150`, `175`, `200`] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** What a window with nothing stored opens at, and what a reset (Ctrl+0) returns to: the stylesheet's own `:root`. */
export const DEFAULT_TEXT_SIZE: TextSize = `compact`;

/** The rungs Settings names; the others are reached by zooming and shown as their percentage. */
export const NAMED_TEXT_SIZES: readonly TextSize[] = [`compact`, `default`, `large`];

const STORAGE_KEY = `ui-text-size`;
const ATTRIBUTE = `data-text-size`;

// Base text size as a share of the browser base font; the multiplier every rem in tokens.css scales off (one
// `[data-text-size]` rule per rung there). Stored as a percentage, not px, so a raised browser base font is preserved.
// `scale` is the same number for pixel widths (useLayout) that need conversion (`--ui-scale` on the CSS side).
const SCALES: Record<TextSize, number> = { 90: 0.9, compact: 1, default: 1.1, large: 1.2, 135: 1.35, 150: 1.5, 175: 1.75, 200: 2 };

const sizes = new Set<string>(TEXT_SIZES);
const isTextSize = (value: unknown): value is TextSize => typeof value === `string` && sizes.has(value);

const apply = (value: TextSize): void => {
    // Compact has no attribute: it's the stylesheet's own `:root` default.
    if (value === DEFAULT_TEXT_SIZE) {
        document.documentElement.removeAttribute(ATTRIBUTE);
    } else {
        document.documentElement.setAttribute(ATTRIBUTE, value);
    }
};

// Read once at boot from index.html's anti-flash attribute, before it reflects live state instead of storage.
const bootAttribute = document.documentElement.getAttribute(ATTRIBUTE);
const BOOT_SIZE: TextSize = isTextSize(bootAttribute) ? bootAttribute : DEFAULT_TEXT_SIZE;

const textSize: Ref<TextSize> = definePreference<TextSize>({
    key: STORAGE_KEY,
    read: (raw) => (isTextSize(raw) ? raw : BOOT_SIZE),
    write: (value) => value,
    apply,
});

const scale: ComputedRef<number> = computed(() => SCALES[textSize.value]);

/** The size as a whole percentage, for saying a rung that has no name ("150%"). */
const percent: ComputedRef<number> = computed(() => Math.round(scale.value * 100));

const setTextSize = (value: TextSize): void => {
    textSize.value = value;
};

/** One rung up (1) or down (-1), held at the ends; 0 goes back to the default. What the zoom keys and Ctrl+wheel do. */
const stepTextSize = (direction: -1 | 0 | 1): void => {
    if (direction === 0) {
        textSize.value = DEFAULT_TEXT_SIZE;
        return;
    }
    const at = TEXT_SIZES.indexOf(textSize.value);
    const next = TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, at + direction))];
    if (next !== undefined) {
        textSize.value = next;
    }
};

export function useTextSize() {
    return { textSize, setTextSize, stepTextSize, scale, percent };
}
