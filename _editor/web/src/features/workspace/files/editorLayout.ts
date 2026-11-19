import { afterResize } from "@intentic/ui";
import type * as Monaco from "monaco-editor-core";

// AN EDITOR FOLLOWS ITS HOST'S SIZE, EXCEPT WHILE A RESIZE HANDLE IS DRAGGED. In place of Monaco's `automaticLayout`,
// which lays the editor out inside its resize observer's callback on every frame the host changes size. Both viewers
// wrap long lines (`wordWrap: bounded`), so each such layout re-wraps every line of the file: measured on a 3,000-line
// file, 22ms a width against 2.8ms unwrapped, a whole frame on every frame of a drag of the chat's edge beside it.
// Here the editor is laid out as Monaco would lay it out (in the callback, to the size the observer reports, so a
// window resize draws no frame at the old size), unless a resize handle is being dragged: then it keeps its size
// (clipped, or with room beside it) until the pointer rests or lets go, and is laid out once at the size it rests at.

/** What follows a host: a code editor or a diff editor, both laid out to a given size. */
export interface LaidOut {
    readonly layout: (dimension?: Monaco.editor.IDimension) => void;
}

/** Lays `editor` out to `host`'s content box whenever it changes; returns what stops following (before disposing it). */
export const followHostSize = (host: HTMLElement, editor: LaidOut): (() => void) => {
    // A component-test DOM has none: the editor keeps the size it was created at.
    if (!(`ResizeObserver` in globalThis)) {
        return () => {};
    }
    let size: Monaco.editor.IDimension | undefined;
    const lay = (): void => editor.layout(size);
    let waiting = (): void => {};
    const observer = new ResizeObserver(([entry]) => {
        size = entry === undefined ? undefined : { width: entry.contentRect.width, height: entry.contentRect.height };
        waiting = afterResize(lay);
    });
    observer.observe(host);
    return () => {
        observer.disconnect();
        waiting();
    };
};
