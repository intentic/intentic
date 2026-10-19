import { ref } from "vue";

// Whether the "Bring a project in" dialog is open. One flag for the window: the Files sidebar, the workspace home and a
// phone's toolbar all press it, and the dialog is mounted once by the page that holds them.
const open = ref(false);

export const useBringProject = () => ({
    open,
    show: (): void => {
        open.value = true;
    },
});
