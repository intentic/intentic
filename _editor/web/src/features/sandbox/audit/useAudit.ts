import type { AuditQuery, AuditRecord } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, ref, toValue, watch } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { rpcKey } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// The audit trail through the daemon's /audit routes, owner and maintainers only (the daemon refuses anyone else).
// The first page is a query keyed by the filters; older pages are fetched on asking and appended, since a trail two
// years long is never read whole.

export type AuditFilters = Pick<AuditQuery, "action" | "actor">;

const PAGE = 100;

export function useAuditLog(filters: MaybeRefOrGetter<AuditFilters>) {
    const input = computed(() => {
        const { action, actor } = toValue(filters);
        const read: AuditQuery = { limit: PAGE };
        if (action !== undefined) {
            read.action = action;
        }
        if (actor !== undefined && actor !== ``) {
            read.actor = actor;
        }
        return read;
    });
    const { query, error } = useSandboxQuery(rpcQuery(`audit.list`, input, { unpersisted: true }));
    const older = ref<AuditRecord[]>([]);
    const olderNext = ref<number>();
    const loadingOlder = ref(false);
    // A new filter starts the list again from its newest page.
    watch(input, () => {
        older.value = [];
        olderNext.value = undefined;
    });
    const next = computed(() => (older.value.length > 0 ? olderNext.value : query.data.value?.next));
    const records = computed<AuditRecord[]>(() => [...(query.data.value?.records ?? []), ...older.value]);
    const loadOlder = async (): Promise<void> => {
        const before = next.value;
        if (before === undefined || loadingOlder.value) {
            return;
        }
        loadingOlder.value = true;
        try {
            const page = await sandboxRpc.audit.list({ ...input.value, before });
            older.value = [...older.value, ...page.records];
            olderNext.value = page.next;
        } finally {
            loadingOlder.value = false;
        }
    };
    return { records, error, isLoading: query.isLoading, hasOlder: computed(() => next.value !== undefined), loadingOlder, loadOlder };
}

// The chain check reads every record kept, so it runs when the page opens and again on asking, never on a timer.
export function useAuditVerify() {
    const queryClient = useQueryClient();
    const { query, error } = useSandboxQuery(rpcQuery(`audit.verify`, undefined, { unpersisted: true }));
    return {
        verdict: computed(() => query.data.value),
        error,
        isChecking: computed(() => query.isFetching.value),
        recheck: (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcKey(`audit.verify`) }),
    };
}

export function useAuditStatus() {
    const { query } = useSandboxQuery(rpcQuery(`audit.status`, undefined, { unpersisted: true }));
    return computed(() => query.data.value);
}

// Saves a period's records as the JSON Lines file the daemon wrote, exactly as stored, so the hashes still check out
// for whoever receives it.
export const downloadAudit = async (from: number, to: number): Promise<number> => {
    const exported = await sandboxRpc.audit.export({ from, to });
    const url = URL.createObjectURL(new Blob([exported.jsonl], { type: `application/x-ndjson;charset=utf-8` }));
    const anchor = document.createElement(`a`);
    anchor.href = url;
    anchor.download = exported.filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return exported.count;
};
