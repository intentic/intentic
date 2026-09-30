import { computed, watch, type ComputedRef, type Ref } from "vue";
import { useRoute } from "vue-router";
import { definePreference } from "@intentic/ui/preference";

// A wallpaper is a picture behind the agents board and a few full-width extension pages, chosen on its own and worn under any look: it is one
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

/**
 * The extension views a wallpaper also shows behind (`/ext/<id>`): pages whose cards or grouped rows have solid
 * backgrounds, keeping their content readable while the picture shows around them.
 */
export const WALLPAPERED_EXTENSIONS: ReadonlySet<string> = new Set([`workflows`, `automations`, `projects`, `pipelines`, `approvals`]);

/** Whether the shell's main column should wear the wallpaper for the route on screen. The board draws its own. */
export function useWallpaperedRoute(): ComputedRef<boolean> {
    const route = useRoute();
    return computed(() => wallpaper.value !== `none` && route.name === `extension` && WALLPAPERED_EXTENSIONS.has(String(route.params[`ext`])));
}
