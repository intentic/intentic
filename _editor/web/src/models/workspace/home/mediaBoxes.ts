import { WORKSPACE_DIMENSIONS_MAX, type WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { sandboxShallowRef, sandboxValue } from "@intentic/extension-api";
import { shallowReactive } from "vue";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { workspaceAgent } from "../../../app/workspaceScope";
import { thumbnailKind } from "./thumbnails";

// The box each picture and video in the home is shown in, as the gallery lays its rows out from: asked of the daemon a
// folder at a time (workspace.dimensions reads only the files' headers), and where it cannot say (an SVG, a sandbox
// from before the route) learned from the picture itself once a tile has drawn it.

export interface MediaBox {
    readonly width: number;
    readonly height: number;
    // A video's running time in seconds, where the daemon could read it.
    readonly duration?: number | undefined;
    // The picture's own pixels, as the daemon read them or a whole picture showed them; otherwise only its proportions,
    // learned from a rendition smaller than the original.
    readonly exact: boolean;
}

// Answers kept: a few numbers each, so the cap is about the map, not memory.
const CAP = 20_000;

// `null` is asked and answered without a box: the gallery guesses its proportions until a tile measures it. One
// sandbox's pictures: a switch starts afresh, and an answer still on its way lands in the map it was asked for.
const boxes = sandboxShallowRef(() => shallowReactive(new Map<string, MediaBox | null>()));
const asking = sandboxValue(() => new Set<string>());

// A rewritten file (same path, new size or time) may be a different picture.
const keyOf = (entry: WorkspaceTreeEntry): string => `${workspaceAgent.value ?? ``}\n${entry.path} ${entry.size ?? 0} ${entry.mtime ?? 0}`;

const keep = (key: string, box: MediaBox | null, into = boxes.value): void => {
    into.set(key, box);
    if (into.size > CAP) {
        const [oldest] = into.keys();
        if (oldest !== undefined) {
            into.delete(oldest);
        }
    }
};

/** The box an entry is shown in, once known. Reactive: a gallery laid out from it lays out again when it lands. */
export const mediaBox = (entry: WorkspaceTreeEntry): MediaBox | undefined => boxes.value.get(keyOf(entry)) ?? undefined;

/** What a drawn tile measured of its own picture, kept where the daemon had no answer, or a better one than before. */
export const reportBox = (entry: WorkspaceTreeEntry, width: number, height: number, exact: boolean): void => {
    const key = keyOf(entry);
    const known = boxes.value.get(key);
    if (width > 0 && height > 0 && (known == null || (exact && !known.exact))) {
        keep(key, { width, height, exact });
    }
};

const ask = async (batch: readonly { readonly entry: WorkspaceTreeEntry; readonly key: string }[]): Promise<void> => {
    const into = boxes.value;
    const pending = asking.value;
    try {
        const { items } = await sandboxRpc.workspace.dimensions({ agent: workspaceAgent.value, paths: batch.map(({ entry }) => entry.path) });
        const byPath = new Map(items.map((item) => [item.path, item]));
        for (const { entry, key } of batch) {
            const item = byPath.get(entry.path);
            keep(key, item === undefined ? null : { width: item.width, height: item.height, duration: item.duration, exact: true }, into);
        }
    } catch {
        // allow(silent-catch): a sandbox that cannot measure (older, or gone a moment) leaves the tiles to measure themselves
        for (const { key } of batch) {
            keep(key, null, into);
        }
    } finally {
        for (const { key } of batch) {
            pending.delete(key);
        }
    }
};

/**
 * Asks for the boxes of a folder's pictures and videos not yet known, in the order given, a request at a time: the
 * first screenful's answer arrives before the rest are asked for.
 */
export const requestBoxes = async (entries: readonly WorkspaceTreeEntry[]): Promise<void> => {
    const wanted = entries.flatMap((entry) => {
        const key = keyOf(entry);
        return thumbnailKind(entry) === undefined || boxes.value.has(key) || asking.value.has(key) ? [] : [{ entry, key }];
    });
    for (const { key } of wanted) {
        asking.value.add(key);
    }
    for (let at = 0; at < wanted.length; at += WORKSPACE_DIMENSIONS_MAX) {
        await ask(wanted.slice(at, at + WORKSPACE_DIMENSIONS_MAX));
    }
};
