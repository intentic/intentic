import { onScopeDispose } from "vue";
import { useRouter } from "vue-router";
import { toHome } from "../../lib/routes/links";
import { registerBuiltin } from "../../workbench/commands/builtinCommands";

export function useHomeCommand(): void {
    const router = useRouter();
    const command = registerBuiltin(`view.home`, () => {
        void router.push(toHome());
    });
    onScopeDispose(() => command.dispose());
}
