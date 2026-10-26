import { computed } from "vue";
import type { PickerOption } from "@intentic/extension-ui";
import { host } from "../host";
import { t } from "../i18n.js";
import { serviceSummary } from "./serviceSummary";

export const useServices = () => {
    const { query } = host().sandbox.query({
        queryKey: host().sandbox.readKey(`services.list`),
        queryFn: async () => {
            try { return await host().sandbox.rpc.services.list(); }
            // Older daemons and readers without service access offer no authority picker.
            catch { return { services: [] }; }
        },
    });
    const { query: profiles } = host().sandbox.query({
        queryKey: host().sandbox.readKey(`accessProfiles.list`),
        queryFn: async () => {
            try { return await host().sandbox.rpc.accessProfiles.list(); }
            // Keep the service id and steward visible even when its profile cannot be read.
            catch { return { profiles: [] }; }
        },
    });
    const services = computed(() => query.data.value?.services ?? []);
    const available = computed(() => services.value.length > 0);
    const label = (id: string): string => services.value.find((service) => service.id === id)?.label ?? id;
    const summary = (id: string): string => {
        const service = services.value.find((entry) => entry.id === id);
        return service === undefined ? (id === `` ? t(`service.authority`) : t(`service.unavailable`, { id })) : serviceSummary(service, profiles.data.value?.profiles ?? []);
    };
    const options = (selected: string, inherit = false): readonly PickerOption[] => [
        { value: ``, label: inherit ? t(`service.inherit`) : t(`service.owner`) },
        ...services.value.map((service) => ({ value: service.id, label: service.label ?? service.id, description: summary(service.id) })),
        ...(selected !== `` && !services.value.some((service) => service.id === selected) ? [{ value: selected, label: selected, description: summary(selected), disabled: true }] : []),
    ];
    return { available, label, summary, options };
};
