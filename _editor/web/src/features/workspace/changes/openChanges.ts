import { router } from "../../../router";
import { useLayout } from "../../../shell/window/useLayout";

// The one way in to the Changes panel from somewhere else in the app. Shared rather than repeated per surface: every
// place that tells the user only they can clear something (a refused land's report, the card that carries it) has to
// land them in the same place, or the instruction and the destination drift apart.
export const openChanges = (): void => {
    useLayout().setSidebarPanel(`changes`);
    void router.push({ name: `workspace` });
};
