import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { onBeforeUnmount, onMounted, type Ref, ref, watch } from "vue";
import { reportBox } from "../../../models/workspace/home/mediaBoxes";
import { stopWaiting, whenNear } from "../../../models/workspace/home/nearViewport";
import { type ThumbnailKind, type TileEdge, tileArt } from "../../../models/workspace/home/thumbnails";

// What a home tile draws in place of its glyph, a grid tile's and a gallery picture's alike: fetched once the tile is
// near the viewport, never for a folder of four hundred off-screen shots, at the edge its box needs. A box that grows
// (the gallery's size, a wider pane) asks for the next edge up and swaps it in once decoded, so the smaller picture
// stays on screen until the sharper one can replace it; a box that shrinks keeps what it has.

export interface TileArtState {
    readonly src: Ref<string | undefined>;
    // A picture (a rendition, or the frame the daemon cut from a video), or a video the element seeks into itself.
    readonly as: Ref<"picture" | "video" | undefined>;
    // Painted, so the swap from glyph to picture can fade rather than pop.
    readonly shown: Ref<boolean>;
    readonly failed: Ref<boolean>;
    readonly onPicture: (event: Event) => void;
    readonly onVideoMetadata: (event: Event) => void;
    readonly onVideoFrame: () => void;
    readonly onError: () => void;
}

// A rewritten file (same path, new size) is a new picture.
const versionOf = (entry: WorkspaceTreeEntry): string => `${entry.path} ${entry.size ?? 0}`;

// Decoded before it is swapped in, so the picture on screen is replaced by a painted one, never by a blank.
export const decoded = async (url: string): Promise<void> => {
    const probe = new Image();
    probe.src = url;
    // allow(silent-catch): a picture that will not decode here fails on the <img> too, whose error handler retries it
    await probe.decode?.().catch(() => undefined);
};

// Starts `load` once the tile comes near the viewport, and forgets it when the tile goes: the home windows its tiles,
// so the unmount runs whenever one scrolls out of reach, not just when the folder closes.
const whenTileNear = (art: Ref<HTMLElement | undefined>, wanted: () => boolean, load: () => void): void => {
    onMounted(() => {
        if (wanted() && art.value !== undefined) {
            whenNear(art.value, load);
        }
    });
    onBeforeUnmount(() => {
        if (art.value !== undefined) {
            stopWaiting(art.value);
        }
    });
};

// What a painted picture or a loaded video says of the file: its proportions, and for a rendition smaller than the
// edge it was asked at, its true size, since the daemon never enlarges one.
const mediaHandlers = (entry: () => WorkspaceTreeEntry, drawnAt: () => TileEdge | undefined, shown: Ref<boolean>) => ({
    onPicture: (event: Event): void => {
        // SAFETY: bound to an <img>'s load event, whose target is that element.
        const img = event.target as HTMLImageElement;
        const at = drawnAt();
        // An SVG's own size is a suggestion, not pixels: it draws as sharp at any size, so it is never "small".
        const vector = entry().name.toLowerCase().endsWith(`.svg`);
        reportBox(entry(), img.naturalWidth, img.naturalHeight, at !== undefined && !vector && Math.max(img.naturalWidth, img.naturalHeight) < at);
        shown.value = true;
    },
    // Where the daemon could not cut a frame, the element seeks for one: a third of the way in, as the daemon would,
    // past the title card or fade a first frame so often is. `preload="metadata"` alone may leave it blank until asked.
    onVideoMetadata: (event: Event): void => {
        // SAFETY: bound to a <video>'s loadedmetadata event, whose target is that element.
        const video = event.target as HTMLVideoElement;
        reportBox(entry(), video.videoWidth, video.videoHeight, true);
        video.currentTime = Number.isFinite(video.duration) && video.duration > 0 ? video.duration / 3 : 0.01;
    },
    onVideoFrame: (): void => {
        shown.value = true;
    },
});

export const useTileArt = (
    entry: () => WorkspaceTreeEntry,
    kind: () => ThumbnailKind | undefined,
    edge: () => TileEdge,
    art: Ref<HTMLElement | undefined>,
): TileArtState => {
    const src = ref<string>();
    const as = ref<"picture" | "video">();
    const shown = ref(false);
    const failed = ref(false);
    let near = false;
    let retried = false;
    // The edge drawn or on its way; a smaller want is already covered.
    let asked: TileEdge | undefined;
    // The edge the picture on screen was drawn at, so what its pixels say about the original is read against it.
    let drawnAt: TileEdge | undefined;

    const load = (): void => {
        const wanted = kind();
        const at = edge();
        if (wanted === undefined || (asked !== undefined && asked >= at)) {
            return;
        }
        asked = at;
        const version = versionOf(entry());
        void tileArt(entry(), wanted, at).then(
            async (answer) => {
                // A larger picture replacing one already painted is decoded first; a first one paints as it lands.
                if (src.value !== undefined && answer.as === `picture`) {
                    await decoded(answer.url);
                }
                // A tile re-used for another file, or already handed a larger edge, keeps what it has.
                if (versionOf(entry()) !== version || asked !== at) {
                    return;
                }
                src.value = answer.url;
                as.value = answer.as;
                drawnAt = answer.edge;
                // An older sandbox answers its viewer's rendition, larger than asked: nothing up to that needs asking again.
                asked = answer.edge > at ? answer.edge : at;
            },
            () => {
                if (src.value === undefined) {
                    failed.value = true;
                }
            },
        );
    };
    whenTileNear(
        art,
        () => kind() !== undefined,
        () => {
            near = true;
            load();
        },
    );
    watch(edge, () => {
        if (near) {
            load();
        }
    });
    watch(
        () => versionOf(entry()),
        () => {
            src.value = undefined;
            as.value = undefined;
            shown.value = false;
            failed.value = false;
            retried = false;
            asked = undefined;
            drawnAt = undefined;
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
        asked = undefined;
        if (retried) {
            failed.value = true;
            return;
        }
        retried = true;
        load();
    };
    return { src, as, shown, failed, onError, ...mediaHandlers(entry, () => drawnAt, shown) };
};
