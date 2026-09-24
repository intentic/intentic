// The text a reader sees: textContent less every `hidden` subtree, which includes the "until-found" material that
// find-in-page can still reach.
export const shownText = (element: Element): string => {
    const copy = element.cloneNode(true) as Element;
    for (const shut of copy.querySelectorAll(`[hidden]`)) {
        shut.remove();
    }
    return copy.textContent ?? ``;
};
