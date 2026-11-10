import { computed, ref } from "vue";
import { sandboxPageInHome } from "../../lib/routes/homeSection";
import { currentRoute, frameOf } from "../../lib/routes/links";

// Whether the desktop shell's rail is unrolled: the address is in Home's frame (`/home`, `/home/<sandbox>/…`, the
// account's pages opened from there; lib/routes/links.ts), so the rail wears the sandboxes and the sections are put away
// in the bookmark at its foot (shell/rail/MasterRail.vue). Folded, it wears one sandbox's sections. The same shell and
// the same page either way: only the rail changes, and it shows the change as it makes it (shell/rail/railMorph.ts).
// Read off the address and nothing else, so Back, a reload and a shared link all come back with the rail as they left
// it: until 2026-11-04 the frame was this window's memory, and Back could not leave Home.
export const masterRail = computed(() => {
    const route = currentRoute();
    return route !== undefined && frameOf(route) === `home`;
});

// Whether what stands beside the rail is a sandbox's own: always with the rail folded, and unrolled around any page of a
// sandbox (lib/routes/homeSection.ts `sandboxPageInHome`). Its status bar, its chat column and its quick bar are drawn
// on this alone, never on the rail's state, so unrolling the rail moves nothing but the rail. Home's own page has its
// one chat as its page, and the account's pages there are no sandbox's.
export const sandboxBeside = computed(() => !masterRail.value || sandboxPageInHome.value);

// THE SAME RAIL IN A DESKTOP WINDOW ON A FOLDER OF THIS COMPUTER (local/LocalShell.vue), unrolled onto every sandbox
// (local/LocalMasterRail.vue) or folded onto This computer. That window has no Home frame for an address to say it, and
// every sandbox it lists opens in the workspace, so its rail's state is the window's own: the cluster under the logo and
// Mod+Alt+H unroll it, and a press on This computer's tile (or the shortcut again) folds it back. A new window opens folded.
// allow(module-state): the one rail of a local window
export const localRailUnrolled = ref(false);
