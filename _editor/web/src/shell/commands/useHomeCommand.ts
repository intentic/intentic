import { onScopeDispose } from "vue";
import { useRouter } from "vue-router";
import { registerBuiltin } from "../../workbench/commands/builtinCommands";

export function useHomeCommand(): void {
    const router = useRouter();
    const command = registerBuiltin(`view.home`, () => {
        void router.push(`/home`);
    });
    onScopeDispose(() => command.dispose());
}
