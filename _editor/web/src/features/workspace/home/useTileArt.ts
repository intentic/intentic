import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { onBeforeUnmount, onMounted, type Ref, ref, watch } from "vue";
import { reportBox } from "../../../models/workspace/home/mediaBoxes";
import { stopWaiting, whenNear } from "../../../models/workspace/home/nearViewport";
import { type ThumbnailKind, type TileSize, tileArt } from "../../../models/workspace/home/thumbnails";

// What a home tile draws in place of its glyph, a grid tile's and a gallery picture's alike: fetched once the tile is
// near the viewport, never for a folder of four hundred off-screen shots, and swapped in only once it has painted.

export interface TileArtState {
    readonly src: Ref<string | undefined>;
    // A picture (a rendition, or the frame the daemon cut from a video), or a video the element seeks into itself.
    readonly as: Ref<"picture" | "video" | undefined>;
    // Painted, so the swap from glyph to picture can fade rather than pop.
    readonly shown: Ref<boolean>;
    readonly failed: Ref<boolean>;
    // The picture's own pixels once painted, for a tile that draws a small one at its size rather than blown up.
    readonly natural: Ref<{ readonly width: number; readonly height: number } | undefined>;
    readonly onPicture: (event: Event) => void;
    readonly onVideoMetadata: (event: Event) => void;
    readonly onVideoFrame: () => void;
    readonly onError: () => void;
}

// A rewritten file (same path, new size) is a new picture.
const versionOf = (entry: WorkspaceTreeEntry): string => `${entry.path} ${entry.size ?? 0}`;

export const useTileArt = (
    entry: () => WorkspaceTreeEntry,
    kind: () => ThumbnailKind | undefined,
    size: TileSize,
    art: Ref<HTMLElement | undefined>,
): TileArtState => {
    const src = ref<string>();
    const as = ref<"picture" | "video">();
    const shown = ref(false);
    const failed = ref(false);
    const natural = ref<{ readonly width: number; readonly height: number }>();
    let near = false;
    let retried = false;

    const load = (): void => {
        const wanted = kind();
        if (wanted === undefined) {
            return;
        }
        const asked = versionOf(entry());
        void tileArt(entry(), wanted, size).then(
            (answer) => {
                // A tile re-used for another file while this was on its way draws that file, not this one.
                if (versionOf(entry()) !== asked) {
                    return;
                }
                src.value = answer.url;
                as.value = answer.as;
            },
            () => {
                failed.value = true;
            },
        );
    };
    onMounted(() => {
        if (kind() === undefined || art.value === undefined) {
            return;
        }
        whenNear(art.value, () => {
            near = true;
            load();
        });
    });
    // The home windows its tiles, so this runs whenever one scrolls out of reach, not just when the folder closes.
    onBeforeUnmount(() => {
        if (art.value !== undefined) {
            stopWaiting(art.value);
        }
    });
    watch(
        () => versionOf(entry()),
        () => {
            src.value = undefined;
            as.value = undefined;
            shown.value = false;
            failed.value = false;
            natural.value = undefined;
            retried = false;
            if (near) {
                load();
            }
        },
    );
    // A URL evicted from the shared cache under a tile still on screen breaks its image; one more fetch gets a fresh one,
    // and a second failure means the file itself, so the glyph stands in.
    const onError = (): void => {
        src.value = undefined;
        shown.value = false;
        if (retried) {
            failed.value = true;
            return;
        }
        retried = true;
        load();
    };
    // A rendition keeps its picture's proportions, which is all a gallery needs of a picture the daemon could not measure.
    const onPicture = (event: Event): void => {
        // SAFETY: bound to an <img>'s load event, whose target is that element.
        const img = event.target as HTMLImageElement;
        natural.value = { width: img.naturalWidth, height: img.naturalHeight };
        reportBox(entry(), img.naturalWidth, img.naturalHeight);
        shown.value = true;
    };
    // Where the daemon could not cut a frame, the element seeks for one: a third of the way in, as the daemon would, past
    // the title card or fade a first frame so often is. `preload="metadata"` alone may leave the element blank until asked.
    const onVideoMetadata = (event: Event): void => {
        // SAFETY: bound to a <video>'s loadedmetadata event, whose target is that element.
        const video = event.target as HTMLVideoElement;
        reportBox(entry(), video.videoWidth, video.videoHeight);
        video.currentTime = Number.isFinite(video.duration) && video.duration > 0 ? video.duration / 3 : 0.01;
    };
    const onVideoFrame = (): void => {
        shown.value = true;
    };
    return { src, as, shown, failed, natural, onPicture, onVideoMetadata, onVideoFrame, onError };
};
