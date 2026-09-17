import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { sandboxBlob } from "../../sandbox/client/sandboxClient";
import { mediaUrl } from "../files/mediaUrl";
import { scopeQuery, workspaceAgent } from "../health/workspaceScope";
import { peekPlan } from "./peekContent";

// One URL per picture or video the desk draws, shared by the tiles and the quick look, so a hover never re-reads what a
// tile already fetched. A picture is its bytes as an object URL; a video is the daemon's ticketed media URL, which the
// element streams by range, so a thumbnail costs a header and a frame rather than the file. Bounded: past the cap the
// oldest goes, and a picture's object URL is revoked with it.

export type ThumbnailKind = "picture" | "video";

export const thumbnailKind = (entry: WorkspaceTreeEntry): ThumbnailKind | undefined => {
    const { kind } = peekPlan(entry);
    return kind === `picture` || kind === `video` ? kind : undefined;
};

const CAP = 96;
// In flight or settled, so a burst of tiles asking for one file makes one request.
const urls = new Map<string, Promise<string>>();

// The scope is part of the key: the same path names a different file in a conversation's own checkout.
const keyOf = (entry: WorkspaceTreeEntry): string => `${workspaceAgent.value ?? ``}\n${entry.path} ${entry.size ?? 0}`;

const fetchUrl = async (entry: WorkspaceTreeEntry, kind: ThumbnailKind): Promise<string> =>
    kind === `picture`
        ? URL.createObjectURL(await sandboxBlob(`/workspace/raw?${scopeQuery(new URLSearchParams({ path: entry.path })).toString()}`))
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
