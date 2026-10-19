import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { useLatest } from "@intentic/ui/async";
import { ref, type Ref, watch } from "vue";
import { heldArt, type TileEdge, tileArt, videoStream } from "../../../../models/workspace/home/thumbnails";
import { decoded } from "../useTileArt";

// What the quick look draws of a picture or a video. At once, the largest picture of it already on hand (the tile's
// own), so the card never opens on a blank; then the rendition at the edge the card's box needs on this screen, swapped
// in once decoded. A video plays its own stream over that picture as its poster.

export interface LookPicture {
    // The picture to draw, or a video's poster.
    readonly picture: Ref<string | undefined>;
    // A video's own stream.
    readonly stream: Ref<string | undefined>;
}

export const useLookPicture = (
    entry: () => WorkspaceTreeEntry | undefined,
    medium: () => "picture" | "video" | undefined,
    edge: () => TileEdge | undefined,
): LookPicture => {
    const picture = ref<string>();
    const stream = ref<string>();
    const latest = useLatest();
    let isLatest = latest();
    // The largest edge asked for the entry looked at; a smaller box is already covered.
    let asked = 0;

    const ask = async (target: WorkspaceTreeEntry, kind: "picture" | "video", at: TileEdge, current: () => boolean): Promise<void> => {
        asked = at;
        try {
            const art = await tileArt(target, kind, at);
            if (art.as !== `picture`) {
                return;
            }
            if (picture.value !== undefined) {
                await decoded(art.url);
            }
            if (current() && asked === at) {
                picture.value = art.url;
            }
        } catch {
            // allow(silent-catch): the picture on hand stays, and with none the card keeps the file's glyph
        }
    };

    const askLarger = (): void => {
        const target = entry();
        const kind = medium();
        const at = edge();
        if (target !== undefined && kind !== undefined && at !== undefined && at > asked) {
            void ask(target, kind, at, isLatest);
        }
    };

    watch(
        [entry, medium],
        ([target, kind]) => {
            isLatest = latest();
            asked = 0;
            picture.value = target === undefined || kind === undefined ? undefined : heldArt(target)?.url;
            stream.value = undefined;
            if (target === undefined || kind === undefined) {
                return;
            }
            if (kind === `video`) {
                const current = isLatest;
                void videoStream(target).then(
                    (url) => {
                        if (current()) {
                            stream.value = url;
                        }
                    },
                    () => undefined,
                );
            }
            askLarger();
        },
        { immediate: true },
    );
    watch(edge, askLarger);

    return { picture, stream };
};
