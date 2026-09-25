import type { MainlineStatus } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, inject, type InjectionKey, provide } from "vue";
import { rpcQuery } from "../../sandbox/client/rpcQuery";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";

// The main tree's own check (GET /workspace/mainline): what it is measuring, what waits for it, what it last said and
// who took a red one. Read ONCE per surface that draws it — the chat rail and the agents board — and handed to that
// surface's cards, so a lane of fifty rows is one read and not fifty. The daemon's `mainline` push keeps it current.
// A daemon that does not serve it, or a read that failed, answers nothing, and every mark drawn from it then draws
// nothing rather than a guess.

const MAINLINE_KEY: InjectionKey<ComputedRef<MainlineStatus | undefined>> = Symbol(`mainline`);

export function useMainline(): ComputedRef<MainlineStatus | undefined> {
    const supported = computed(() => supportsRoute(`workspace.mainline`));
    const { query } = useSandboxQuery({ ...rpcQuery(`workspace.mainline`), enabled: supported });
    return computed(() => (!supported.value || query.isError.value ? undefined : query.data.value));
}

// The host's one read, provided to every card below it.
export const provideMainline = (): ComputedRef<MainlineStatus | undefined> => {
    const status = useMainline();
    provide(MAINLINE_KEY, status);
    return status;
};

// What a card reads; nothing outside a host that provides it, so a card drawn anywhere else never starts a read.
export const injectMainline = (): ComputedRef<MainlineStatus | undefined> | undefined => inject(MAINLINE_KEY, undefined);
