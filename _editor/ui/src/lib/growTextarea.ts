// Height is measured, not guessed. Order matters:
// - reset to `auto` first: a set height is a floor `scrollHeight` can't report under.
// - below one line's height means "not laid out yet" (detached, hidden); the one-row default stands.
// - border is added back manually, since `scrollHeight` excludes it.
// - an empty field is measured with its placeholder swapped in as the value, then reverted.
//
// Not for <ProseField>, which sizes itself with a CSS grid replica instead.
export const growTextarea = (element: HTMLTextAreaElement | null | undefined, maxHeight?: number): void => {
    if (element === null || element === undefined) {
        return;
    }
    element.style.height = `auto`;
    const style = getComputedStyle(element);
    const oneLine = Number.parseFloat(style.lineHeight) + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const throughPlaceholder = element.value === `` && element.placeholder !== ``;
    if (throughPlaceholder) {
        element.value = element.placeholder;
    }
    const measured = element.scrollHeight;
    if (throughPlaceholder) {
        element.value = ``;
    }
    if (measured <= 0 || measured < oneLine) {
        return;
    }
    const border = style.boxSizing === `border-box` ? Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth) : 0;
    const height = measured + border;
    element.style.height = `${maxHeight === undefined ? height : Math.min(height, maxHeight)}px`;
};
