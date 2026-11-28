import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { host } from "./host";
import { type AddSourceSchema, type DiscoverHitView, type PublishRequestSchema, routes, type Snapshot } from "./wire";
import type { z } from "zod";

/* THE VIEW'S DATA: the backend's snapshot (sources, the curated feed, settings, whether the reader may change things)
   and the presses, each answering the snapshot as it stands after it, so one press refreshes the whole view. */

// The backend reads on its own schedule; a minute here is only how soon a poll the reader did not press shows.
const POLL_MS = 60_000;

const snapshotKey = () => host().sandbox.key(`network`, `snapshot`);

// What a press sends: a source to add, one to read now, or a switch.
type PressBody = z.input<typeof AddSourceSchema> | z.input<typeof PublishRequestSchema> | { readonly source?: string } | { readonly enabled: boolean };
const send = <T>(path: string, method: `POST` | `DELETE`, body?: PressBody): Promise<T> =>
    host().backend.json<T>(path, { method, headers: { "content-type": `application/json` }, body: JSON.stringify(body ?? {}) });

export const useNetwork = () => {
    const client = useQueryClient();
    const snapshot = useQuery({
        queryKey: snapshotKey(),
        queryFn: (): Promise<Snapshot> => host().backend.json<Snapshot>(routes.snapshot),
        refetchInterval: POLL_MS,
    });
    const settle = (next: Snapshot): void => {
        client.setQueryData(snapshotKey(), next);
    };
    const refresh = useMutation({ mutationFn: (source: string | undefined) => send<Snapshot>(routes.refresh, `POST`, source === undefined ? {} : { source }), onSuccess: settle });
    const add = useMutation({ mutationFn: (input: z.input<typeof AddSourceSchema>) => send<Snapshot>(routes.sources, `POST`, input), onSuccess: settle });
    const remove = useMutation({ mutationFn: (id: string) => send<Snapshot>(`${routes.sources}/${encodeURIComponent(id)}`, `DELETE`), onSuccess: settle });
    const toggle = useMutation({
        mutationFn: ({ id, enabled }: { readonly id: string; readonly enabled: boolean }) => send<Snapshot>(`${routes.sources}/${encodeURIComponent(id)}/enable`, `POST`, { enabled }),
        onSuccess: settle,
    });
    const curate = useMutation({ mutationFn: () => send<{ conversationId: string }>(routes.curate, `POST`) });
    // A publication or a withdrawal goes to Approvals; the snapshot shows it waiting there.
    const afterFiling = (): Promise<void> => client.invalidateQueries({ queryKey: snapshotKey() });
    const publish = useMutation({ mutationFn: (input: z.input<typeof PublishRequestSchema>) => send<{ approval: string }>(routes.publish, `POST`, input), onSuccess: afterFiling });
    const withdraw = useMutation({ mutationFn: (seq: number) => send<{ approval: string }>(`${routes.withdraw}/${seq}`, `POST`), onSuccess: afterFiling });
    const release = useMutation({ mutationFn: (sourceId: string) => send<Snapshot>(`${routes.peers}/${encodeURIComponent(sourceId)}/release`, `POST`), onSuccess: settle });
    // A search over the guides this sandbox trusts, made on a press: each answer's catalog is verified by the backend.
    const discover = useMutation({
        mutationFn: async ({ type, keyword }: { readonly type: string; readonly keyword: string }) => {
            const params = new URLSearchParams();
            if (type !== ``) {
                params.set(`type`, type);
            }
            if (keyword.trim() !== ``) {
                params.set(`keyword`, keyword.trim());
            }
            return (await host().backend.json<{ hits: DiscoverHitView[] }>(`${routes.discover}?${params}`)).hits;
        },
    });
    return { snapshot, refresh, add, remove, toggle, curate, publish, withdraw, release, discover };
};
