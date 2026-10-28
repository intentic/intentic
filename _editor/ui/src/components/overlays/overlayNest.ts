import { inject, type InjectionKey, provide } from "vue";

// PANELS OPENED FROM INSIDE A PANEL: a picker's list inside a popover, a time list inside a sheet's form. Each one is
// teleported to the body, so to its parent's "was that press outside me?" a press on the child's list looks like a
// press on the page, and the parent closed under the reader's pointer, taking the child with it. And one Escape went
// to every open panel at once. So each open panel tells the panel it was opened from that it is there: a press inside
// any panel opened from this one is inside this one too, and Escape is the newest panel's alone.

export interface OverlayNest {
    /** A panel opened from this one, while it is open: whether a node lies in it or in anything opened from it. */
    readonly add: (child: (node: Node) => boolean) => () => void;
}

const NEST: InjectionKey<OverlayNest> = Symbol(`overlay-nest`);

/** This panel's place among the panels: what it tells the panel it was opened from, and what it asks of its own. */
export const useOverlayNest = (ownBox: () => HTMLElement | undefined) => {
    const parent = inject(NEST, undefined);
    const children = new Set<(node: Node) => boolean>();
    provide(NEST, {
        add: (child) => {
            children.add(child);
            return () => children.delete(child);
        },
    });
    const holds = (node: Node): boolean => ownBox()?.contains(node) === true || [...children].some((child) => child(node));
    let leave: (() => void) | undefined;
    return {
        /** A press here, or in a panel opened from here. */
        holds,
        /** Whether a panel opened from this one is open now: Escape is then its, not this one's. */
        covered: (): boolean => children.size > 0,
        /** Tells the panel this one was opened from that it is open, until `closed`. */
        opened: (): void => {
            leave?.();
            leave = parent?.add(holds);
        },
        closed: (): void => {
            leave?.();
            leave = undefined;
        },
    };
};
