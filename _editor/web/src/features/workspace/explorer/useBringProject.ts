import { sandboxRef } from "@intentic/extension-api";

// Whether the "Bring a project in" dialog is open. One flag for the window: the Files sidebar, the workspace home and a
// phone's toolbar all press it, and the dialog is mounted once by the page that holds them. Scoped to the sandbox, since
// the project it brings lands in this one: a switch closes it rather than offering the next sandbox the same dialog.
const open = sandboxRef(() => false);

export const useBringProject = () => ({
    open,
    show: (): void => {
        open.value = true;
    },
});
