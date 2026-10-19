import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { computed, ref } from "vue";
import { galleryArtOf } from "../homeGallery";

// The home's full-window view of its pictures and videos (HomeLightbox.vue). Opened on purpose, never by a hover: Space
// on the selected one, as Finder's Quick Look opens, or the expand button a gallery tile shows under the pointer. A
// gallery's tiles are already the pictures, so a card raised by every pause of the pointer would only cover them.

export const useHomeLightbox = (
    order: () => readonly WorkspaceTreeEntry[],
    gallery: () => boolean,
    focusTile: (index: number) => Promise<void>,
    // The hover card, which a full-window view replaces.
    closeLook: () => void,
) => {
    const viewing = ref<string>();
    // Every picture and video of the folder, in the home's order: what the view's arrows step through.
    const viewable = computed(() => order().filter((entry) => galleryArtOf(entry) !== undefined));

    const view = (entry: WorkspaceTreeEntry | undefined): boolean => {
        if (entry === undefined || galleryArtOf(entry) === undefined) {
            return false;
        }
        closeLook();
        viewing.value = entry.path;
        return true;
    };
    // Space on a selected picture or video; on anything else it is still the first letter of a filter.
    const onSpace = (event: KeyboardEvent, selected: WorkspaceTreeEntry | undefined): boolean => {
        if (event.key !== ` ` || event.ctrlKey || event.metaKey || event.altKey || !view(selected)) {
            return false;
        }
        event.preventDefault();
        return true;
    };
    // Closed on the picture it ended on: that tile is selected, scrolled into view and holds the keyboard.
    const closed = (last: string | undefined): void => {
        const at = order().findIndex((entry) => entry.path === last);
        if (at !== -1) {
            void focusTile(at);
        }
    };
    // A gallery's picture is already itself on the page: a hover raises no card over it.
    const inPlace = (entry: WorkspaceTreeEntry): boolean => gallery() && galleryArtOf(entry) !== undefined;
    return { viewing, viewable, view, onSpace, closed, inPlace };
};
