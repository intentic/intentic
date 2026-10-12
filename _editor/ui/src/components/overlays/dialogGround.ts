import { inject, provide, type InjectionKey } from "vue";

// WHAT IS ALREADY A CARD. A dialog is the surface its contents lie on: a <RowGroup> or a <Card> inside it that drew its
// own rounded, shadowed box put a card on a card, and the eye read two frames where there is one thing. So <Modal> says
// so once, and the kit's surfaces answer by drawing none of their own: a group is its rows and their hairlines, a card
// is its contents. Grouping inside a dialog is space, a section label and a rule, never a second box.
const DIALOG_GROUND: InjectionKey<boolean> = Symbol(`ui.dialog.ground`);

/** Called by <Modal> for everything in its body and footer. */
export const provideDialogGround = (): void => provide(DIALOG_GROUND, true);

/** Whether this component is drawn on a dialog, and so must not draw a surface of its own. */
export const useDialogGround = (): boolean => inject(DIALOG_GROUND, false);
