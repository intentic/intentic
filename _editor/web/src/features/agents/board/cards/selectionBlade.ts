import { type ShallowRef, shallowRef, watch } from "vue";

// The blade a selected session card sweeps (styles.css `.session-card-on::before`), handed to the card as the mask
// it wears in its own style.
//
// ONE IMAGE PER SELECTION. The sweep is SMIL inside the SVG the mask is drawn from (styles.css says why it is not a
// CSS animation), and a SMIL animation in a CSS image runs on that image's own clock, which starts when the image is
// first drawn. The browser keeps one image per URL, so cards sharing a URL would sweep on one clock that started
// whenever the first of them was drawn, and a click would land anywhere in its cycle. A URL of its own each time a
// card becomes selected starts the sweep on the click: 1.5s across, then 6.5s still, round again. The band starts with
// its leading edge at the card's edge and leaves at speed (an ease-out), so the first frames after the click show it
// moving; starting further off the card behind an ease-in read as a pause before anything happened. Its edge is
// transparent, so a repeat does not pop in.

let minted = 0;

const blade = (n: number): string =>
    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' data-n='${n}' viewBox='0 0 1 1' preserveAspectRatio='none'%3E` +
    `%3ClinearGradient id='b' x1='-.6' x2='0' y2='.25'%3E` +
    `%3Cstop offset='0' stop-opacity='0'/%3E%3Cstop offset='.5'/%3E%3Cstop offset='1' stop-opacity='0'/%3E` +
    `%3Canimate attributeName='x1' values='-.6;1.5;1.5' keyTimes='0;.19;1' calcMode='spline' keySplines='.15 .4 .3 1;0 0 1 1' dur='8s' repeatCount='indefinite'/%3E` +
    `%3Canimate attributeName='x2' values='0;2.1;2.1' keyTimes='0;.19;1' calcMode='spline' keySplines='.15 .4 .3 1;0 0 1 1' dur='8s' repeatCount='indefinite'/%3E` +
    `%3C/linearGradient%3E%3Crect width='1' height='1' fill='url(%23b)'/%3E%3C/svg%3E")`;

/** The style a session card binds on its root: a fresh blade each time `selected` turns true, none while it is not. */
export const useSelectionBlade = (selected: () => boolean | undefined): ShallowRef<Record<string, string> | undefined> => {
    const style = shallowRef<Record<string, string> | undefined>();
    watch(
        () => selected() === true,
        (on) => {
            minted += on ? 1 : 0;
            style.value = on ? { "--session-card-blade": blade(minted) } : undefined;
        },
        { immediate: true },
    );
    return style;
};
