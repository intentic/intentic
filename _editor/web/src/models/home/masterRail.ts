import { computed } from "vue";
import { currentRoute, frameOf } from "../../lib/routes/links";

// Whether the desktop shell is in the master view: the address is in Home's frame (`/home`, `/home/<sandbox>/…`, the
// account's pages opened from there; lib/routes/links.ts). The rail wears the sandboxes. On Home's own page no chat column
// is docked beside, since its one chat is its page; around a page of a sandbox, the page decides
// (lib/routes/homeSection.ts homeFrame). Read off the address and nothing else, so Back, a reload and a shared link all
// come back in the frame they left: until 2026-11-04 the frame was this window's memory, and Back could not leave Home.
export const masterRail = computed(() => {
    const route = currentRoute();
    return route !== undefined && frameOf(route) === `home`;
});
