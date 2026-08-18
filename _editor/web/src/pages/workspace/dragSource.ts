/* WHOSE DRAG IS THIS, AND WHAT IS IT OFFERING — the one question every drop target in the workspace has to
 * answer the same way, which is why it lives here rather than in whichever surface asked it first.
 *
 * A browser makes every <img> (and every link) a drag source, and Chromium types an in-page image drag as
 * `Files` — the same shape a file dragged off the desktop has. So grabbing the previewed image to move it used
 * to raise "drop files to add to the workspace", and letting go uploaded a copy of the file being LOOKED at
 * into the repo. Nothing already inside the workspace is an upload, however the drag store types it, so a drag
 * that started in this document is declined: dragstart marks it, dragend clears it (drop must NOT — it fires
 * first, and the drop handler still needs to know). pointerdown clears it as well, because it always precedes
 * a dragstart, so the mark can't outlive its drag even when the source element is removed mid-gesture (a tree
 * row under a file the agent just deleted) and dragend never arrives.
 *
 * The explorer's rows and its background both consult this: a drop the background would decline must not be
 * accepted by a row simply because the pointer happened to be over one. */

let fromThisDocument = false;
const markDragSource = (): void => {
    fromThisDocument = true;
};
const clearDragSource = (): void => {
    fromThisDocument = false;
};

// What a drag is offering this surface: OS files to upload, tree rows to move, or nothing it can use (an image
// or a link dragged around inside the app) — in which case the target raises no hint and declines the drop.
export const dragOffer = (event: DragEvent): { files: boolean; rows: boolean } => {
    const types = event.dataTransfer?.types;
    // OS-file drags expose the "Files" type; an internal tree-row move exposes our custom path key instead.
    return { files: !fromThisDocument && (types?.includes(`Files`) ?? false), rows: types?.includes(`application/x-intentic-path`) ?? false };
};

// Keeps the mark honest for as long as a workspace surface is on screen; returns the disposer. Capture phase
// throughout, so a handler that calls stopPropagation can't hide a drag's start or end from it.
export const watchDragSource = (): (() => void) => {
    window.addEventListener(`pointerdown`, clearDragSource, true);
    window.addEventListener(`dragstart`, markDragSource, true);
    window.addEventListener(`dragend`, clearDragSource, true);
    return () => {
        window.removeEventListener(`pointerdown`, clearDragSource, true);
        window.removeEventListener(`dragstart`, markDragSource, true);
        window.removeEventListener(`dragend`, clearDragSource, true);
    };
};
