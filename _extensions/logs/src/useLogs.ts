import { type LogFileEntry, type LogRead, LogReadSchema, LogsListSchema } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* The daemon-owned debug logs, via its /logs routes: terminal pipe-pane captures, intentic CLI run logs, and
 * the daemon's own log file — everything under historyRoot/logs. Plain polling; debug logs don't need
 * sub-second freshness. All daemon access goes through the host api (auth + per-sandbox cache scoping injected
 * host-side). */

const POLL_MS = 10_000;

export function useLogs() {
    const api = host();
    const files = useQuery({
        queryKey: api.sandbox.key(`logs`),
        queryFn: async () => LogsListSchema.parse(await api.sandbox.json(`/logs`)).files,
        enabled: computed(() => api.sandbox.reachable()),
        refetchInterval: POLL_MS,
    });
    return {
        files: computed<LogFileEntry[]>(() => files.data.value ?? []),
        error: computed(() => files.error.value?.message),
        isLoading: computed(() => files.isLoading.value),
    };
}

export function useLogTail(name: Ref<string | undefined>, bytes: Ref<number>) {
    const api = host();
    const tail = useQuery({
        queryKey: computed(() => api.sandbox.key(`logs-file`, name.value ?? ``, String(bytes.value))),
        queryFn: async () =>
            LogReadSchema.parse(await api.sandbox.json(`/logs/file?name=${encodeURIComponent(name.value ?? ``)}&bytes=${bytes.value}`)),
        enabled: computed(() => api.sandbox.reachable() && name.value !== undefined),
        refetchInterval: POLL_MS,
    });
    return {
        tail: computed<LogRead | undefined>(() => tail.data.value),
        error: computed(() => tail.error.value?.message),
        isLoading: computed(() => tail.isLoading.value),
        refetch: tail.refetch,
    };
}
