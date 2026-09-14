import type { DiffPayload } from "@intentic/extension-api";
import type { SnapshotChange } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { host } from "./host.js";
import { byDay, timelineRows } from "./timeline.js";
import { waitingRows } from "./waiting.js";

// The daemon reads behind "What's new" and "Waiting for you": the tree's restore points and the fleet, re-read on a
// short clock since both move while the page is open, and again the moment the page does something to them.

const SNAPSHOTS_EVERY_MS = 15_000;
const AGENTS_EVERY_MS = 8_000;

// A binary file's two sides come from the raw-diff route per side, keyed to the checkpoint; an added file has no
// before, a deleted one no after.
const rawSides = (snapshot: string, change: SnapshotChange): Pick<DiffPayload, "beforeRaw" | "afterRaw"> => {
    const side = (which: `before` | `after`): string =>
        `/diff/raw?${new URLSearchParams({ source: `checkpoint`, snapshot, scope: change.scope, path: change.path, which }).toString()}`;
    return {
        ...(change.status === `added` ? {} : { beforeRaw: side(`before`) }),
        ...(change.status === `deleted` ? {} : { afterRaw: side(`after`) }),
    };
};

export function useTimeline() {
    const api = host();
    const queryClient = useQueryClient();
    const reachable = computed(() => api.sandbox.reachable());

    const snapshotsKey = computed(() => api.sandbox.key(`project`, `snapshots`));
    const snapshots = useQuery({
        queryKey: snapshotsKey,
        queryFn: () => api.sandbox.rpc.history.list(),
        enabled: reachable,
        refetchInterval: SNAPSHOTS_EVERY_MS,
    });
    const agentsKey = computed(() => api.sandbox.key(`project`, `agents`));
    const agents = useQuery({
        queryKey: agentsKey,
        queryFn: () => api.sandbox.rpc.agents.list(),
        enabled: reachable,
        refetchInterval: AGENTS_EVERY_MS,
    });

    const now = ref(Date.now());
    const rows = computed(() => timelineRows(snapshots.data.value?.snapshots ?? [], agents.data.value?.agents ?? []));
    const days = computed(() => {
        now.value = Date.now();
        return byDay(rows.value, now.value);
    });
    const waiting = computed(() => waitingRows(agents.data.value?.agents ?? []));

    // What one point changed, read when its row opens; not cached across points, a row is opened once or twice.
    const changesOf = (id: string): Promise<readonly SnapshotChange[]> => api.sandbox.rpc.history.diff({ id }).then((body) => body.changes);

    // Opens the tab at once and fills it when the read lands, the same two steps the workspace's own panel takes.
    const openChange = (snapshot: string, change: SnapshotChange): void => {
        const tab: DiffPayload = {
            key: snapshot,
            scope: change.scope,
            label: change.path.split(`/`).at(-1) ?? change.path,
            status: change.status,
            path: change.path,
            ...rawSides(snapshot, change),
            pending: true,
        };
        api.workspace.openDiff(tab);
        void api.sandbox.rpc.history.fileDiff({ id: snapshot, scope: change.scope, path: change.path }).then((body) => api.workspace.fillDiff({ ...tab, ...body }));
    };

    // Puts every file back the way it stood at the point; the daemon saves a point of the present first.
    const restore = async (id: string): Promise<void> => {
        await api.sandbox.rpc.history.restore({ id });
        await queryClient.invalidateQueries({ queryKey: snapshotsKey.value });
    };

    const refresh = async (): Promise<void> => {
        await Promise.all([queryClient.invalidateQueries({ queryKey: snapshotsKey.value }), queryClient.invalidateQueries({ queryKey: agentsKey.value })]);
    };

    return { days, rows, waiting, isLoading: snapshots.isLoading, changesOf, openChange, restore, refresh };
}
