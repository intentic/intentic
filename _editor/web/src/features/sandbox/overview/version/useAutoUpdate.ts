import type { AutoUpdateInput } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { rpcPrefix } from "../../../../lib/queryKeys";
import { queryClient } from "../../../../lib/queryPersistence";
import { useAuth } from "../../../../client/auth/useAuth";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { useRole } from "../../../../client/sandbox/useRole";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { NOT_NOW_MS, notTodayUntil } from "./autoUpdate";
import { useSandboxVersion } from "./useSandboxVersion";

// The owner's hands on an update that takes itself: the switch, a pause, and "now". Each answer is the daemon's own
// state afterwards, and /info is read again rather than patched, so the card redraws from the daemon's word. The daemon
// pushes every move of its own (the `update` runtime domain), so nothing here polls.
export function useAutoUpdate() {
    const { info } = useSandboxVersion();
    const { user } = useAuth();
    // Maintainer-floored at the daemon, like the update itself; anyone else reads the state and changes nothing.
    const { canShip } = useRole();

    const auto = computed(() => info.value?.autoUpdate);
    // Present on /info only where this sandbox can update itself, and only from a daemon that serves the route.
    const served = computed(() => auto.value !== undefined && supportsRoute(`system.autoUpdate`));
    const canSteer = computed(() => served.value && canShip.value);
    // How the daemon may name this reader among the people at the editor.
    const me = computed((): readonly string[] => [user.value?.name, user.value?.email].filter((value): value is string => value !== undefined && value !== ``));

    const configure = async (input: AutoUpdateInput): Promise<void> => {
        await sandboxRpc.system.autoUpdate(input);
        await queryClient.invalidateQueries({ queryKey: rpcPrefix(`system.info`) });
    };

    return {
        auto,
        served,
        canSteer,
        me,
        setEnabled: (enabled: boolean): Promise<void> => configure({ enabled }),
        notToday: (): Promise<void> => configure({ pausedUntil: notTodayUntil(Date.now()) }),
        notNow: (): Promise<void> => configure({ pausedUntil: Date.now() + NOT_NOW_MS }),
        resume: (): Promise<void> => configure({ pausedUntil: null }),
        applyNow: (): Promise<void> => configure({ applyNow: true }),
    };
}
