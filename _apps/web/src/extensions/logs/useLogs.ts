import { type LogFileEntry, type LogRead, LogReadSchema, LogsListSchema } from "@intentic-app/api-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { sandboxJson } from "../../composables/sandboxClient";
import { sandboxKey, useSandbox } from "../../composables/useSandbox";

/* The daemon-owned debug logs, via its /logs routes: terminal pipe-pane captures, intentic CLI run logs, and
 * the daemon's own log file — everything under historyRoot/logs. Plain polling; debug logs don't need
 * sub-second freshness. */

const POLL_MS = 10_000;

export function useLogs() {
    const { reachable } = useSandbox();
    const files = useQuery({
        queryKey: sandboxKey(`logs`),
        queryFn: async () => LogsListSchema.parse(await sandboxJson(`/logs`)).files,
        enabled: reachable,
        refetchInterval: POLL_MS,
    });
    return {
        files: computed<LogFileEntry[]>(() => files.data.value ?? []),
        error: computed(() => files.error.value?.message),
        isLoading: computed(() => files.isLoading.value),
    };
}

export function useLogTail(name: Ref<string | undefined>, bytes: Ref<number>) {
    const { reachable } = useSandbox();
    const tail = useQuery({
        queryKey: computed(() => sandboxKey(`logs-file`, name.value, bytes.value)),
        queryFn: async () => LogReadSchema.parse(await sandboxJson(`/logs/file?name=${encodeURIComponent(name.value ?? ``)}&bytes=${bytes.value}`)),
        enabled: computed(() => reachable.value && name.value !== undefined),
        refetchInterval: POLL_MS,
    });
    return {
        tail: computed<LogRead | undefined>(() => tail.data.value),
        error: computed(() => tail.error.value?.message),
        isLoading: computed(() => tail.isLoading.value),
        refetch: tail.refetch,
    };
}
