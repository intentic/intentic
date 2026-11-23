import type { SystemDesktop } from "@intentic/sandbox-contract/schemas/terminal";
import { computed, type ComputedRef } from "vue";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";

// The sandbox's own desktop as the status bar's chip and the Desktop view both read it (like browsersQuery): whether it is up and
// how many windows are open on it. Nothing polls; the daemon pushes the `desktop` domain as a window opens or closes
// (agent-desktop.ts watches its window manager's client list). A daemon older than the read answers nothing, which
// reads as "nothing known": no tile, and no claim that the desktop is empty. Each connected runner's desktop rides along
// (`runners`, runnerDesktops.ts); `windows` counts this sandbox's own.

export const useDesktopQuery = (): { readonly state: ComputedRef<SystemDesktop | undefined>; readonly windows: ComputedRef<number | undefined> } => {
    const { query } = useSandboxQuery(rpcQuery(`system.desktop`, undefined, { background: true }));
    const state = computed(() => query.data.value);
    // Known only while it runs under a window manager; undefined is "can't tell", never "none".
    const windows = computed(() => (state.value?.running === true ? state.value.windows : undefined));
    return { state, windows };
};

// Every desktop's windows together, this sandbox's and its runners', for the rail's tile, and the tab of the desktop
// with the most of them, which a press on the tile opens. Undefined while no desktop can say.
export interface DesktopsSummary {
    readonly windows: number | undefined;
    readonly tab: string;
}
export const desktopsSummary = (state: SystemDesktop | undefined): DesktopsSummary => {
    const counts = [
        { tab: `desktop`, windows: state?.running === true ? state.windows : undefined },
        ...(state?.runners ?? []).map((entry) => ({ tab: `desktop:${entry.runner}`, windows: entry.state.running ? entry.state.windows : undefined })),
    ].filter((entry): entry is { tab: string; windows: number } => entry.windows !== undefined);
    const busiest = counts.toSorted((left, right) => right.windows - left.windows)[0];
    return { windows: counts.length === 0 ? undefined : counts.reduce((sum, entry) => sum + entry.windows, 0), tab: busiest?.tab ?? `desktop` };
};
