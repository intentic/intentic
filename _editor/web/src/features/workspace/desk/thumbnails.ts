import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { sandboxBlob } from "../../sandbox/client/sandboxClient";
import { mediaUrl } from "../files/mediaUrl";
import { scopeQuery, workspaceAgent } from "../health/workspaceScope";
import { peekPlan } from "./peekContent";

// One URL per picture or video the desk draws, shared by the tiles and the quick look, so a hover never re-reads what a
// tile already fetched. A picture is the daemon's downscaled WebP (/workspace/thumb) as an object URL, a few kilobytes
// rather than the file — drawing a folder of screenshots from the originals moved a gigabyte and made the browser hold
// every one of them decoded at full size. A video is the daemon's ticketed media URL, which the element streams by
// range, so a thumbnail costs a header and a frame rather than the file. Bounded: past the cap the oldest goes, and a
// picture's object URL is revoked with it.
//
// Fetched rather than handed to the element as a URL: this route takes the bearer header like any other read, and a
// per-file ticket (what <video> needs) would be a round trip per tile.

export type ThumbnailKind = "picture" | "video";

export const thumbnailKind = (entry: WorkspaceTreeEntry): ThumbnailKind | undefined => {
    const { kind } = peekPlan(entry);
    return kind === `picture` || kind === `video` ? kind : undefined;
};

// Held URLs. Generous because each is a few kilobytes now, and the desk only draws what is on screen: scrolling back up
// a long folder should find its tiles already there rather than re-reading them.
const CAP = 512;
// In flight or settled, so a burst of tiles asking for one file makes one request.
const urls = new Map<string, Promise<string>>();

// The scope is part of the key: the same path names a different file in a conversation's own checkout.
const keyOf = (entry: WorkspaceTreeEntry): string => `${workspaceAgent.value ?? ``}\n${entry.path} ${entry.size ?? 0}`;

const fetchUrl = async (entry: WorkspaceTreeEntry, kind: ThumbnailKind): Promise<string> =>
    kind === `picture`
        ? URL.createObjectURL(await sandboxBlob(`/workspace/thumb?${scopeQuery(new URLSearchParams({ path: entry.path })).toString()}`))
        : mediaUrl(entry.path);

const evictOldest = (): void => {
    if (urls.size <= CAP) {
        return;
    }
    const [oldest] = urls;
    if (oldest === undefined) {
        return;
    }
    urls.delete(oldest[0]);
    void oldest[1].then(
        (url) => {
            if (url.startsWith(`blob:`)) {
                URL.revokeObjectURL(url);
            }
        },
        () => undefined,
    );
};

export const thumbnailUrl = (entry: WorkspaceTreeEntry, kind: ThumbnailKind): Promise<string> => {
    const key = keyOf(entry);
    const pending = urls.get(key);
    if (pending !== undefined) {
        return pending;
    }
    const loading = fetchUrl(entry, kind);
    urls.set(key, loading);
    // A failed read is forgotten, so the next look retries rather than failing for the rest of the session.
    loading.catch(() => urls.delete(key));
    evictOldest();
    return loading;
};
