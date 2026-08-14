import type { AutomationTemplate, TriggerSource } from "@intentic/sandbox-contract";
import type { CapabilityFacts } from "@intentic/extension-api";
import type { IconName } from "@intentic/extension-ui";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";

/* WHAT CAN WAKE AN AGENT HERE, AND WHAT TO START FROM — asked of the daemon, in one read.
 *
 * This used to be two hand-written tables in this package: every source (the website widget, CI) and every
 * template (GitHub, GitLab, Sentry, Stripe, Komodo, email, and every chore in the book). Both lived in the
 * SURFACE, which meant a pack that gained something worth reacting to could not say so without an edit to a
 * page it has nothing to do with — and the daemon kept a second copy of the source list to validate against,
 * which is a disagreement waiting for whichever copy was edited second.
 *
 * Now the daemon merges what it emits itself with what every installed pack declares, and this draws whatever
 * comes back. The page knows the name of no integration, and `upsert` accepts exactly what the picker offers
 * because there is only one list. */

// A capability's `provider` is the slug a source and a template name it by — the connected INSTANCE, not the
// card it was made from, which is why this reads config rather than the manifest.
const connectedProviders = (capabilities: readonly CapabilityFacts[]): ReadonlySet<string> =>
    new Set(capabilities.flatMap((capability) => (typeof capability.config[`provider`] === `string` ? [capability.config[`provider`]] : [])));

/* WHETHER THIS CAN BE CHOSEN RIGHT NOW, which is a different question from whether it can be DESCRIBED. A pack
 * that is switched off, or one whose capability nobody has connected, still has to name the trigger of an
 * automation already standing on it — so a stored row stays readable and editable while the picker declines to
 * offer it as a new choice.
 *
 * `requires` is satisfied by ANY of its entries: a CI trigger rides github or gitlab, and demanding both would
 * refuse the common case. Empty means there is nothing to connect. */
const satisfied = (requires: readonly string[], connected: ReadonlySet<string>): boolean =>
    requires.length === 0 || requires.some((provider) => connected.has(provider));

// A source the form can reason about: the declaration, plus the one thing only this browser knows — whether
// what it needs is connected right now. Resolved once per capability change rather than per source read.
export interface AvailableSource extends TriggerSource {
    readonly available: boolean;
}

export const withAvailability = (sources: readonly TriggerSource[], capabilities: readonly CapabilityFacts[]): readonly AvailableSource[] => {
    const connected = connectedProviders(capabilities);
    return sources.map((source) => ({ ...source, available: source.enabled && satisfied(source.requires, connected) }));
};

// A template carries no `enabled` of its own: the catalogue drops a switched-off pack's templates already,
// because a template is a thing you have not made yet and offering one would offer a row that cannot fire.
export const availableTemplates = (
    templates: readonly AutomationTemplate[],
    capabilities: readonly CapabilityFacts[],
): readonly AutomationTemplate[] => {
    const connected = connectedProviders(capabilities);
    return templates.filter((template) => satisfied(template.requires, connected));
};

/* A stored automation outlives the pack that supplied its provider. The catalogue keeps a switched-off pack's
 * row precisely so this rarely has to fire, but an UNINSTALLED one leaves nothing behind — so the row degrades
 * to a generic source that can still be read and edited, and reinstalling fills the real label back in without
 * touching the record. */
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

/* A DECLARED GLYPH, MET BY THE ICON SET. Both a source and a template leave `icon` an open string, because
 * neither the wire contract nor the manifest schema may depend on the UI kit to name one — and a contributed
 * pack is naming a glyph it cannot import either way. So the cast happens here, at the one boundary where the
 * two vocabularies meet, and an unknown name renders the icon set's own fallback rather than nothing. */
export const glyph = (name: string | undefined): IconName | undefined => name as IconName | undefined;

const NO_SOURCES: readonly TriggerSource[] = [];
const NO_TEMPLATES: readonly AutomationTemplate[] = [];

/* The catalogue, through the host's cache. It moves when a pack is installed, switched or updated — all three
 * of which restart the extension host and re-run this activation — so it is read once rather than polled. */
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
