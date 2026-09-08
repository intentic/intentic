import { computed, type ComputedRef, type Ref } from "vue";
import { definePreference } from "./preference.js";

export type TextSize = "compact" | "default" | "large";

const STORAGE_KEY = `ui-text-size`;
const ATTRIBUTE = `data-text-size`;

const sizes = new Set<string>([`compact`, `default`, `large`]);

// Base text size (compact/default/large = 100/110/120% of the browser base font); the multiplier every rem in
// tokens.css scales off. Stored as a percentage, not px, so a raised browser base font is preserved. `scale` is
// the same number for pixel widths (useLayout) that need conversion (`--ui-scale` on the CSS side).
const SCALES: Record<TextSize, number> = { compact: 1, default: 1.1, large: 1.2 };

const isTextSize = (value: unknown): value is TextSize => typeof value === `string` && sizes.has(value);

const apply = (value: TextSize): void => {
    // Compact has no attribute: it's the stylesheet's own `:root` default.
    if (value === `compact`) {
        document.documentElement.removeAttribute(ATTRIBUTE);
    } else {
        document.documentElement.setAttribute(ATTRIBUTE, value);
    }
};

// Read once at boot from index.html's anti-flash attribute, before it reflects live state instead of storage.
const bootAttribute = document.documentElement.getAttribute(ATTRIBUTE);
const BOOT_SIZE: TextSize = isTextSize(bootAttribute) ? bootAttribute : `compact`;

const textSize: Ref<TextSize> = definePreference<TextSize>({
    key: STORAGE_KEY,
    read: (raw) => (isTextSize(raw) ? raw : BOOT_SIZE),
    write: (value) => value,
    apply,
});

const scale: ComputedRef<number> = computed(() => SCALES[textSize.value]);

const setTextSize = (value: TextSize): void => {
    textSize.value = value;
};

export function useTextSize() {
    return { textSize, setTextSize, scale };
}
