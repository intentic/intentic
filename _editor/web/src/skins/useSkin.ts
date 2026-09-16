import { computed, watch, type ComputedRef, type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { useTheme } from "@intentic/ui/theme";

// A skin (`sanctum`) is the workspace's whole look, applied as one `data-skin` attribute on <html>; a skin's CSS is
// scoped to `[data-skin=...]`, so `none` writes no attribute. Sanctum is built on a near-black canvas and has no
// daylight dress, so pinning it forces the dark scheme. A skin used to fetch its own webfont as it was applied; every
// face the app uses is served from this origin now (src/styles/faces.css), so there is nothing left for a skin to load.

/** What is on <html>. */
export type Skin = "none" | "sanctum";
/** What the setting holds; `system` is the default, and means "whatever the resolved scheme asks for". */
export type SkinChoice = "system" | Skin;

const STORAGE_KEY = `ui-skin`;
const ATTRIBUTE = `data-skin`;
const isSkin = (value: unknown): value is Skin => value === `none` || value === `sanctum`;

const apply = (value: Skin): void => {
    if (value === `none`) {
        document.documentElement.removeAttribute(ATTRIBUTE);
    } else {
        document.documentElement.setAttribute(ATTRIBUTE, value);
    }
};

const choice: Ref<SkinChoice> = definePreference<SkinChoice>({
    key: STORAGE_KEY,
    read: (raw) => (isSkin(raw) ? raw : `system`),
    write: (value) => value,
});

const { scheme, set: setScheme } = useTheme();

// THE APP'S OWN LOOK, IN EACH LIGHT: sanctum is the dark one and there is no light one, so daylight is the app
// undressed. Derived rather than stored, so an OS that flips at dusk carries the whole look with it.
const skin: ComputedRef<Skin> = computed(() => (choice.value === `system` ? (scheme.value === `dark` ? `sanctum` : `none`) : choice.value));

watch(skin, apply, { immediate: true, flush: `sync` });

const setSkin = (value: SkinChoice): void => {
    choice.value = value;
    // Only an explicit pick of the skin drags the scheme with it: `system` is already agreeing with the scheme, and
    // forcing dark there would pin the very setting the reader just handed back to the OS.
    if (value === `sanctum`) {
        setScheme(`dark`);
    }
};

export function useSkin() {
    return { skin, choice, setSkin };
}
