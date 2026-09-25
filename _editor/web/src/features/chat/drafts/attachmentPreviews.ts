import { isAudioPath, isImagePath } from "./fileQuickLook";
import { forgetOriginal, picture, rememberOriginal } from "../../workspace/home/thumbnails";

// An attachment's own bytes as an element's source, the file's original (thumbnails.ts); `rememberMedia` seeds an upload.

// What the bytes are, kept apart from the path: a staged upload is typed by its MIME, whatever it is named.
export type MediaKind = "image" | "audio";

const kindOfPath = (path: string): MediaKind | undefined => (isImagePath(path) ? `image` : isAudioPath(path) ? `audio` : undefined);

// Kinds this window staged, by path; a restored attachment has only its name to go on.
const staged = new Map<string, MediaKind>();

// The bytes are already in this window, filed under the path they were uploaded to; called by the composer as it stages a file.
export const rememberMedia = (path: string, kind: MediaKind, url: string): void => {
    staged.set(path, kind);
    rememberOriginal(path, url);
};

// Drops a path whose staged object URL was just revoked; only ever a file that was never sent.
export const forgetMedia = (path: string): void => {
    staged.delete(path);
    forgetOriginal(path);
};

// Which chip an attachment gets, asked before any URL exists so composer and sent bubble agree; undefined is a file chip.
export const attachmentKind = (path: string): MediaKind | undefined => staged.get(path) ?? kindOfPath(path);

// The bytes' URL only where they are of the asked-for kind; undefined while in flight and for a refused path.
const mediaOf = (path: string, kind: MediaKind): string | undefined =>
    attachmentKind(path) === kind ? picture(undefined, path, `original`)?.url : undefined;

export const attachmentPreview = (path: string): string | undefined => mediaOf(path, `image`);
export const attachmentAudio = (path: string): string | undefined => mediaOf(path, `audio`);
