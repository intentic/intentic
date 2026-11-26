import type { ExtensionManifest } from "@intentic/extension-manifest";
import type { IconName } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import { computed, type ComputedRef } from "vue";
import { useExtensions } from "../extensions/useExtensions";

// WHERE A CONVERSATION CAME IN FROM, for a source an extension's listener supplies (2026-11-26): named as the listener's
// declaration names it (`contributes.listener.automation.label`, the words the automation editor offers it under) and
// drawn with its extension's own mark. Replaced a table of three providers (Discord, Slack, email) in
// agentStatus-meta.ts, which named every other extension's source by its bare slug. A daemon of any age serves these
// declarations, since listeners have declared their label from the start.

export interface OriginSource {
    readonly label: string;
    // The extension's glyph from the app's icon set, when its manifest names one; else the conversation glyph.
    readonly icon: IconName;
    // Its brand mark (a simple-icons slug), when its manifest names one.
    readonly logo?: string | undefined;
}

// Each listener provider an enabled extension declares, as its conversations' origin reads.
export const listenerOrigins = (manifests: readonly ExtensionManifest[]): ReadonlyMap<string, OriginSource> =>
    new Map(
        manifests.flatMap((manifest): (readonly [string, OriginSource])[] => {
            const listener = manifest.contributes?.listener;
            if (listener === undefined) {
                return [];
            }
            const icon = manifest.icon !== undefined && isIconName(manifest.icon) ? manifest.icon : `comments`;
            return [[listener.provider, { label: listener.automation.label, icon, logo: manifest.logo }]];
        }),
    );

/** The listener sources of the extensions switched on now. */
export const useOriginSources = (): ComputedRef<ReadonlyMap<string, OriginSource>> => {
    const { enabled } = useExtensions();
    return computed(() => listenerOrigins(enabled.value.map((extension) => extension.manifest)));
};
