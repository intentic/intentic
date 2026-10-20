import { defineComponent, inject, provide, type InjectionKey } from "vue";

// WHAT IS ALREADY A SURFACE. A dialog, a card and a group's own card are each the ground their contents lie on: a
// <RowGroup> or a <Card> inside one that drew its own rounded, shadowed box put a card on a card, and the eye read two
// frames where there is one thing. So each surface says so once, and the kit's surfaces answer by drawing none of their
// own: a group is its rows and their hairlines, a card is its contents, a section header sits flush with the words
// beside it. Grouping on a surface is space, a section header and a rule, never a second box. Nothing at a call site
// decides this (RowGroup's old `flat` was that decision, made by hand per view), so a nesting cannot get it wrong.
const GROUND: InjectionKey<boolean> = Symbol(`ui.surface.ground`);

/** Called by <Modal> for everything in its body and footer, and by <Card> for its contents. */
export const provideSurfaceGround = (): void => provide(GROUND, true);

/** Whether this component is drawn on a surface, and so must not draw one of its own. */
export const useSurfaceGround = (): boolean => inject(GROUND, false);

/** Its slot lies on a surface: what <RowGroup> wraps its rows in, so its own header still reads the ground under it. */
export const SurfaceGround = defineComponent({
    name: `SurfaceGround`,
    setup(_, { slots }) {
        provideSurfaceGround();
        return () => slots[`default`]?.();
    },
});
