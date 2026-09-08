// Whose drag is this, and what does it offer: every drop target in the workspace answers the same way. An in-app image
// or link drag is typed `Files` too, like an OS file drop, so `fromThisDocument` (set on dragstart, cleared on dragend
// or pointerdown) tells them apart.

let fromThisDocument = false;
const markDragSource = (): void => {
    fromThisDocument = true;
};
const clearDragSource = (): void => {
    fromThisDocument = false;
};

// What a drag offers this surface: OS files, tree rows to move, or nothing usable (an in-app image/link), which
// declines with no hint.
export const dragOffer = (event: DragEvent): { files: boolean; rows: boolean } => {
    const types = event.dataTransfer?.types;
    // OS-file drags expose the "Files" type; an internal tree-row move exposes our custom path key instead.
    return { files: !fromThisDocument && (types?.includes(`Files`) ?? false), rows: types?.includes(`application/x-intentic-path`) ?? false };
};

// Keeps the mark honest while a workspace surface is mounted; returns the disposer. Capture phase, so stopPropagation
// elsewhere can't hide a drag's start or end.
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
