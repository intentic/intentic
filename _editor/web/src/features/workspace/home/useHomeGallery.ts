import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { computed, watch } from "vue";
import { mediaBox, requestBoxes } from "../../../models/workspace/home/mediaBoxes";
import { GALLERY_HEIGHT_MAX, GALLERY_HEIGHT_MIN, GALLERY_HEIGHT_STEP, galleryHeight, useGalleryChoice } from "./galleryChoice";
import { aspectFor, galleryArtOf, hasGalleryArt, readsAsGallery, typicalAspect } from "./homeGallery";
import type { HomeGallery, HomeProbed } from "./homeLayout";

// The home's gallery for the folder open: whether it is on, and the metrics its rows are laid out by (homeGallery.ts).
// On by itself where the folder is mostly pictures or videos, and the reader's to turn either way for any folder
// holding one (galleryChoice.ts); offered only where there is a picture for it to draw.

const aspectOfBox = (entry: WorkspaceTreeEntry): number | undefined => {
    const box = mediaBox(entry);
    return box === undefined ? undefined : box.width / box.height;
};

export const useHomeGallery = (dir: () => string, listed: () => readonly WorkspaceTreeEntry[], probed: () => HomeProbed) => {
    const offered = computed(() => hasGalleryArt(listed()));
    const choice = useGalleryChoice(dir, () => readsAsGallery(listed()));
    const on = computed(() => offered.value && choice.on.value);
    const toggle = (): void => {
        choice.set(!on.value);
    };
    // Smaller and larger by a step, as a photo library's zoom does.
    const resize = (step: -1 | 1): void => {
        galleryHeight.value = Math.min(GALLERY_HEIGHT_MAX, Math.max(GALLERY_HEIGHT_MIN, galleryHeight.value + step * GALLERY_HEIGHT_STEP));
    };
    // The rows' shapes come from the daemon before any picture loads, so a row is laid out once rather than reflowing as
    // its pictures arrive; one a tile measures itself (an SVG) moves only its own row.
    watch(
        [on, listed],
        ([gallery, entries]) => {
            if (gallery) {
                void requestBoxes(entries);
            }
        },
        { immediate: true },
    );
    // The folder's typical shape, for the pictures not measured yet: a row laid out early is near the row it becomes.
    const typical = computed(() =>
        on.value ? typicalAspect(listed().flatMap((entry) => (galleryArtOf(entry) === undefined ? [] : (aspectOfBox(entry) ?? [])))) : undefined,
    );
    // The rows fill the pane less each card's frame: a card is its picture plus padding either side, so the rows are
    // justified over the pictures alone, with the frames counted into the gap between them.
    const gallery = computed<HomeGallery | undefined>(() => {
        if (!on.value) {
            return undefined;
        }
        const { width, galleryPad: pad, galleryGap: gap, galleryCaption } = probed();
        const known = typical.value;
        return {
            width: width - 2 * pad,
            gap: gap + 2 * pad,
            targetHeight: galleryHeight.value,
            captionHeight: galleryCaption,
            rowGap: gap,
            drawn: (group) => group.entries.some((entry) => galleryArtOf(entry) !== undefined),
            aspectOf: (entry) => aspectFor(entry, aspectOfBox(entry), known),
        };
    });
    return { offered, on, toggle, resize, gallery };
};
