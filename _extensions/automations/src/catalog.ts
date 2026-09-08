import type { AutomationTemplate, TriggerSource } from "@intentic/sandbox-contract";
import type { CapabilityFacts } from "@intentic/extension-api";
import type { IconName } from "@intentic/extension-ui";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

// What can wake an agent here, and what to start from, in one read from the daemon: it merges what it emits itself with
// what every installed pack declares. The page names no integration itself, and `upsert` accepts exactly what the
// picker offers, since there is only one list.

// `provider` names the connected instance, not the card it was made from, so this reads the capability's config, not
// its manifest.
const connectedProviders = (capabilities: readonly CapabilityFacts[]): ReadonlySet<string> =>
    new Set(capabilities.flatMap((capability) => (typeof capability.config[`provider`] === `string` ? [capability.config[`provider`]] : [])));

// Whether this can be picked now, not whether it can be described: an existing row stays readable even when its pack is
// off. `requires` needs any one entry, not all, so a CI trigger doesn't demand both github and gitlab.
const satisfied = (requires: readonly string[], connected: ReadonlySet<string>): boolean =>
    requires.length === 0 || requires.some((provider) => connected.has(provider));

// The declaration plus the one thing only this browser knows: whether it's connected right now, resolved once per
// capability change.
export interface AvailableSource extends TriggerSource {
    readonly available: boolean;
}

export const withAvailability = (sources: readonly TriggerSource[], capabilities: readonly CapabilityFacts[]): readonly AvailableSource[] => {
    const connected = connectedProviders(capabilities);
    return sources.map((source) => ({ ...source, available: source.enabled && satisfied(source.requires, connected) }));
};

// No `enabled` of its own: the catalogue already drops a switched-off pack's templates, since offering one would offer
// a row that can't fire.
export const availableTemplates = (
    templates: readonly AutomationTemplate[],
    capabilities: readonly CapabilityFacts[],
): readonly AutomationTemplate[] => {
    const connected = connectedProviders(capabilities);
    return templates.filter((template) => satisfied(template.requires, connected));
};

// An automation outlives its provider's pack; an uninstalled one degrades to a generic, still-editable source, and
// reinstalling fills the real label back in untouched.
export const listenerSourceOf = (sources: readonly AvailableSource[], provider: string, eventType?: string): AvailableSource =>
    sources.find((source) => source.provider === provider) ?? {
        provider,
        label: provider,
        enabled: false,
        available: false,
        requires: [],
        events: eventType === undefined ? [] : [{ value: eventType, label: eventType }],
        channel: { label: `Channel ID (optional)`, placeholder: `all channels` },
    };

// `icon` is an open string in the contract, since neither it nor a pack's manifest may depend on the UI kit's names;
// cast here, at the one boundary, where an unknown name falls back rather than renders nothing.
export const glyph = (name: string | undefined): IconName | undefined => name as IconName | undefined;

const NO_SOURCES: readonly TriggerSource[] = [];
const NO_TEMPLATES: readonly AutomationTemplate[] = [];

// Read once, not polled: installing, switching or updating a pack restarts the extension host and re-runs this anyway.
export function useCatalog() {
    const api = host();
    const query = useQuery({
        queryKey: api.sandbox.key(`automation-catalog`),
        queryFn: () => api.sandbox.rpc.automations.catalog(),
        enabled: computed(() => api.sandbox.reachable()),
    });
    return {
        sources: computed<readonly TriggerSource[]>(() => query.data.value?.sources ?? NO_SOURCES),
        templates: computed<readonly AutomationTemplate[]>(() => query.data.value?.templates ?? NO_TEMPLATES),
        error: computed(() => query.error.value?.message),
    };
}
