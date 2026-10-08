import type { DesktopState } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";

// The sandbox's own desktop as the status bar's chip and the Desktop view both read it (like browsersQuery): whether it is up and
// how many windows are open on it. Nothing polls; the daemon pushes the `desktop` domain as a window opens or closes
// (agent-desktop.ts watches its window manager's client list). A daemon older than the read answers nothing, which
// reads as "nothing known": no tile, and no claim that the desktop is empty.

export const useDesktopQuery = (): { readonly state: ComputedRef<DesktopState | undefined>; readonly windows: ComputedRef<number | undefined> } => {
    const { query } = useSandboxQuery(rpcQuery(`system.desktop`, undefined, { background: true }));
    const state = computed(() => query.data.value);
    // Known only while it runs under a window manager; undefined is "can't tell", never "none".
    const windows = computed(() => (state.value?.running === true ? state.value.windows : undefined));
    return { state, windows };
};
