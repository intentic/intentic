import { onScopeDispose } from "vue";
import { useRouter } from "vue-router";
import { frameOf, toHome } from "../../lib/routes/links";
import { foldedPath, unrolledPath } from "../../models/sandbox/sandboxScreen";
import { registerBuiltin } from "../../workbench/commands/builtinCommands";

// ALL SANDBOXES, by keyboard and from the palette. On a desktop (`inPlace`) it is the same press as the cluster under
// the switcher (shell/rail/OtherSandboxes.vue): it unrolls the sandboxes along the rail around the page on screen, and
// pressed again folds the rail back onto the sandbox on screen, so one shortcut looks along the sandboxes and returns.
// A phone has no rail to unroll: there it opens Home, its list of sandboxes.
export function useHomeCommand(inPlace = false): void {
    const router = useRouter();
    const command = registerBuiltin(`view.home`, () => {
        const route = router.currentRoute.value;
        if (!inPlace) {
            void router.push(toHome());
            return;
        }
        void router.push(frameOf(route) === `home` ? (foldedPath(route) ?? route.fullPath) : unrolledPath(route));
    });
    onScopeDispose(() => command.dispose());
}
