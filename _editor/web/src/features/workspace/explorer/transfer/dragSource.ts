// Whose drag is this: every drop target in the workspace answers the same way. The one drag the page reads is an OS
// file drag, which begins outside the page; an in-app image or link drag is typed `Files` too, so `fromThisDocument`
// (set on dragstart, cleared on dragend or pointerdown) tells them apart. Rows and tiles move by pointer instead
// (useEntryDrag), never by the platform's own drag loop.

let fromThisDocument = false;
const markDragSource = (): void => {
    fromThisDocument = true;
};
const clearDragSource = (): void => {
    fromThisDocument = false;
};

// Whether a drag offers this surface files from outside; an in-app image or link drag declines with no hint.
export const filesOffered = (event: DragEvent): boolean => !fromThisDocument && (event.dataTransfer?.types.includes(`Files`) ?? false);

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
