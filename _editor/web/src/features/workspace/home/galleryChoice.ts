import { computed } from "vue";
import { z } from "zod";
import { definePreference, numberPreference } from "@intentic/ui/preference";
import { activeSandboxId } from "../../../app/storage/activeSandbox";

// What the reader chose of the home's gallery: how tall its rows stand, one size for every folder, and which folders
// they turned it on or off for against what the folder's contents suggest (homeGallery.ts `readsAsGallery`). Per
// folder, as a file manager remembers a folder's view: a Screenshots folder stays a gallery and a project's assets
// folder stays tiles, whichever the reader made them, the next time either is opened.

// The row height a gallery aims for, in pixels: from a contact sheet to pictures big enough to read text in.
export const GALLERY_HEIGHT_MIN = 120;
export const GALLERY_HEIGHT_MAX = 360;
const GALLERY_HEIGHT_DEFAULT = 200;
export const GALLERY_HEIGHT_STEP = 20;

const clampHeight = (value: number): number => Math.min(GALLERY_HEIGHT_MAX, Math.max(GALLERY_HEIGHT_MIN, Math.round(value)));

export const galleryHeight = numberPreference(`ui-home-gallery-height`, clampHeight, () => GALLERY_HEIGHT_DEFAULT);

// Folders kept, newest choice last; past this the oldest choices are forgotten and those folders go back to the guess.
const FOLDERS_KEPT = 300;

// A value from an older build, or one edited by hand, is no choice: every folder falls back to the guess.
const ChoicesSchema = z.record(z.string(), z.boolean()).catch({});
type Choices = Readonly<Record<string, boolean>>;

const readChoices = (raw: string | null): Choices => {
    if (raw === null) {
        return {};
    }
    try {
        return ChoicesSchema.parse(JSON.parse(raw));
    } catch {
        // allow(silent-catch): stored text that is not JSON is no choice either; the guess stands
        return {};
    }
};

const choices = definePreference<Choices>({
    key: `ui-home-gallery-folders`,
    read: readChoices,
    write: (value) => (Object.keys(value).length === 0 ? null : JSON.stringify(value)),
});

// The same path names a different folder in another sandbox.
const folderKey = (dir: string): string => `${activeSandboxId.value ?? ``}:${dir}`;

/**
 * Whether a folder is drawn as a gallery: the reader's choice for it if they made one, else what its contents suggest.
 * `set` records a choice only where it differs from the suggestion, so a folder whose contents change keeps following
 * them unless the reader said otherwise.
 */
export const useGalleryChoice = (dir: () => string, suggested: () => boolean) => {
    const on = computed(() => choices.value[folderKey(dir())] ?? suggested());
    const set = (value: boolean): void => {
        const key = folderKey(dir());
        const { [key]: _was, ...rest } = choices.value;
        const kept = Object.entries(rest).slice(-(FOLDERS_KEPT - 1));
        choices.value = Object.fromEntries(value === suggested() ? kept : [...kept, [key, value]]);
    };
    return { on, set };
};
