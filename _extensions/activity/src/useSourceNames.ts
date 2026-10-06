import { useQuery } from "@tanstack/vue-query";
import { computed, type ComputedRef, type InjectionKey } from "vue";
import { DIRECT, SCHEDULE } from "./episodes";
import { host } from "./host";
import { t } from "./i18n";

// What each source is called, from the manifest that owns it: a listener's provider by the label its automation editor
// shows (`contributes.listener.automation.label`), so a newly installed gateway is named without a release of this
// extension. The keys no extension owns (you, a schedule, the core's web chat) take this extension's translated words.
export function useSourceNames(): ComputedRef<ReadonlyMap<string, string>> {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`extensions`),
        queryFn: () => api.sandbox.rpc.extensions.list(),
        enabled: computed(() => api.sandbox.reachable()),
    });
    return computed(() => {
        const names = new Map<string, string>([
            [DIRECT, t(`sources.you`)],
            [SCHEDULE, t(`sources.schedule`)],
            [`webchat`, t(`sources.webchat`)],
        ]);
        for (const extension of query.data.value?.extensions ?? []) {
            const listener = extension.manifest.contributes?.listener;
            if (listener?.automation !== undefined && !names.has(listener.provider)) {
                names.set(listener.provider, listener.automation.label);
            }
        }
        return names;
    });
}

// Provided once by the view, read by every row, so a long feed holds one query rather than one per row.
export const SOURCE_NAMES: InjectionKey<ComputedRef<ReadonlyMap<string, string>>> = Symbol(`activity.sourceNames`);
