import type { AutomationTemplate, TriggerSource } from "@intentic/sandbox-contract/schemas/automations";
import type { CapabilityFacts } from "@intentic/extension-api";
import type { IconName } from "@intentic/extension-ui";
import { computed } from "vue";
import { host } from "./host";
import { t } from "./i18n.js";
import base from "./locales/en.json";

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
        channel: { label: t(`catalog.channelIdOptional`), placeholder: t(`catalog.allChannels`) },
    };

// `icon` is an open string in the contract, since neither it nor a pack's manifest may depend on the UI kit's names;
// cast here, at the one boundary, where an unknown name falls back rather than renders nothing.
export const glyph = (name: string | undefined): IconName | undefined => name as IconName | undefined;

// A first-party pack's listener words that this editor's catalogs carry (`catalog.microsoft365`), each looked up only
// while the pack still says what en.json holds for it, so a pack edited since shows its own words rather than a stale
// translation. Provider ids and event values never change, and the starter prompt stays the pack's: it is written for
// the agent, not the reader.
const MICROSOFT = base.catalog.microsoft365;

const said = (english: string, held: string, translated: () => string): string => (english === held ? translated() : english);

export const sourceWords = (source: TriggerSource): TriggerSource => {
    if (source.provider !== `microsoft365`) {
        return source;
    }
    const sender = source.sender;
    return {
        ...source,
        events: source.events.map((event) =>
            event.value === `mail` ? { ...event, label: said(event.label, MICROSOFT.mail, () => t(`catalog.microsoft365.mail`)) } : event,
        ),
        channel: { ...source.channel, label: said(source.channel.label, MICROSOFT.folder, () => t(`catalog.microsoft365.folder`)) },
        mentionLabel:
            source.mentionLabel === undefined ? undefined : said(source.mentionLabel, MICROSOFT.mention, () => t(`catalog.microsoft365.mention`)),
        sender:
            sender === undefined
                ? undefined
                : {
                      ...sender,
                      label: said(sender.label, MICROSOFT.sender, () => t(`catalog.microsoft365.sender`)),
                      hint:
                          sender.hint === undefined ? undefined : said(sender.hint, MICROSOFT.senderHint, () => t(`catalog.microsoft365.senderHint`)),
                  },
    };
};

const NO_SOURCES: readonly TriggerSource[] = [];
const NO_TEMPLATES: readonly AutomationTemplate[] = [];

// Read once, not polled: installing, switching or updating a pack restarts the extension host and re-runs this anyway.
export function useCatalog() {
    const api = host();
    const { query, error } = api.sandbox.query({
        queryKey: api.sandbox.readKey(`automations.catalog`),
        queryFn: () => api.sandbox.rpc.automations.catalog(),
    });
    return {
        sources: computed<readonly TriggerSource[]>(() => (query.data.value?.sources ?? NO_SOURCES).map(sourceWords)),
        templates: computed<readonly AutomationTemplate[]>(() => query.data.value?.templates ?? NO_TEMPLATES),
        error,
    };
}
