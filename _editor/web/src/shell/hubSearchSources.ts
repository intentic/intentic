import { useDevice } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import { computed } from "vue";
import { useAudience } from "../app/useAudience";
import { desktopNotices } from "../app/environments/desktopNotices";
import { localFace } from "../app/environments/local";
import { useRole } from "../client/sandbox/useRole";
import { useOrgPolicy } from "../features/organisations/useOrgPolicy";
import { SETTINGS_CARDS, settingsPages, settingsPageTerms } from "../features/settings/settingsIndex";
import { settingsSections } from "../features/settings/settingsNav";
import { useCapabilities } from "../models/capabilities/useCapabilities";
import { usePanels } from "../models/extensions/usePanels";
import { useHostedPlan } from "../models/hosted-plan/useHostedPlan";
import { SANDBOX_CARDS, sandboxPageTerms } from "../models/sandbox/sandboxIndex";
import { isTabbedRow, sandboxKeyAllowed, sandboxSectionGroups, sandboxSections } from "../models/sandbox/sandboxNav";
import { detectActivations } from "../workbench/views/registry";
import type { HubPage, HubReader, HubSource } from "../workbench/hub/hubSearch";
import type { HubSearchSources } from "../workbench/hub/useHubSearch";

// The two hubs' pages and cards as THIS reader may open them: what the hub's own search field and the palette both
// answer from. Gated by the same tables, the same role and the same plan the hubs draw their indexes from, so an answer
// never names a page the hub would bounce the reader off (useNavigationCommands.ts gates its destinations the same way).
// Here rather than beside the search (workbench/hub/useHubSearch.ts) because it names both hubs and the models behind
// them, which the workbench sits below; main.ts hands it down.

export function useHubSearchSources(): HubSearchSources {
    const { canShip, isGuest } = useRole();
    const { hidden: orgHidden } = useOrgPolicy();
    const { offered: planOffered } = useHostedPlan();
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    const { mobile } = useDevice();
    const { maker } = useAudience();
    // A desktop window on a folder of this computer has no sandbox, so no sandbox hub to search.
    const noSandbox = localFace() !== undefined;

    const reader = computed<HubReader>(() => ({ maker: maker.value, phone: mobile.value, app: desktopNotices(), canShip: canShip.value }));

    const sandboxSource = computed<HubSource | undefined>(() => {
        if (noSandbox) {
            return undefined;
        }
        // The row a page sits under, where one row stands for several (Privacy & safety's tabs), so an answer says where
        // in the index it is as well as what it is.
        const rowOf = new Map(
            sandboxSectionGroups()
                .flatMap((group) => group.items)
                .flatMap((row) => (isTabbedRow(row) ? row.parts.map((part) => [part.slug, row.label] as const) : [])),
        );
        const builtIn = sandboxSections(canShip.value, isGuest.value, orgHidden.value).map((section): HubPage => ({
            slug: section.slug,
            label: section.label,
            icon: section.icon,
            row: rowOf.get(section.slug),
        }));
        // An extension's own page on the hub, by its name alone: what its cards are is the extension's to say.
        const extensions = detectActivations(panels.value, capabilities.value)
            .filter(({ extension, activation }) => extension.surface === `sandbox` && sandboxKeyAllowed(activation.key))
            .map(({ activation }): HubPage => ({
                slug: activation.key,
                label: activation.title,
                // The hub's own fallback for an extension row whose glyph the icon set lacks (SandboxHub.vue).
                icon: activation.icon !== undefined && isIconName(activation.icon) ? activation.icon : `th-large`,
            }));
        return { hub: `sandbox`, pages: [...builtIn, ...extensions], entries: SANDBOX_CARDS, pageTerms: sandboxPageTerms() };
    });

    const settingsSource = computed<HubSource>(() => ({
        hub: `settings`,
        pages: settingsPages(settingsSections(planOffered.value, mobile.value)),
        entries: SETTINGS_CARDS,
        pageTerms: settingsPageTerms(),
    }));

    const sources = computed<readonly HubSource[]>(() =>
        sandboxSource.value === undefined ? [settingsSource.value] : [sandboxSource.value, settingsSource.value],
    );

    return { sources, reader };
}
