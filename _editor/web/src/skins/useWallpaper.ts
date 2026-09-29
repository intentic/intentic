import { watch, type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

// A wallpaper is a picture behind the agents board, chosen on its own and worn under any look: it is one
// `data-wallpaper` attribute on <html>, and wallpapers.css draws it, picking each picture's dark or light master from
// the scheme. `none` writes no attribute, and is the default: the board keeps its plain canvas until someone picks one.

/** Every wallpaper there is; the list the Appearance row offers, in order. */
export const WALLPAPERS = [`none`, `mist`] as const;
export type Wallpaper = (typeof WALLPAPERS)[number];

const STORAGE_KEY = `ui-wallpaper`;
const ATTRIBUTE = `data-wallpaper`;
const isWallpaper = (value: unknown): value is Wallpaper => WALLPAPERS.includes(value as Wallpaper);

const apply = (value: Wallpaper): void => {
    if (value === `none`) {
        document.documentElement.removeAttribute(ATTRIBUTE);
    } else {
        document.documentElement.setAttribute(ATTRIBUTE, value);
    }
};

const wallpaper: Ref<Wallpaper> = definePreference<Wallpaper>({
    key: STORAGE_KEY,
    read: (raw) => (isWallpaper(raw) ? raw : `none`),
    write: (value) => value,
});

watch(wallpaper, apply, { immediate: true, flush: `sync` });

export function useWallpaper() {
    return { wallpaper };
}
