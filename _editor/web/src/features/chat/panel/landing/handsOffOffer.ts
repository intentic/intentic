import { parseJsonWith } from "@intentic/base/json";
import type { SandboxMode } from "@intentic/constants";
import { definePreference } from "@intentic/ui/preference";
import type { Ref } from "vue";
import { z } from "zod";
import type { Audience } from "../../../../app/useAudience";
import { HANDS_OFF_DISMISSED_KEY } from "../../../../app/storage/browserStorage";

// Who HandsOffOffer.vue asks, and where it was put away. Module state, not the component's: one preference per account
// on this browser, whichever chats are open, so "Not now" in one window holds in every other, and another account
// opening the same sandbox is still asked.

const DismissedSchema = z.array(z.string());

// allow(module-state): the sandboxes this account was told "not now" for here, shared by every window through the preference channel
export const offerDismissed: Ref<readonly string[]> = definePreference<readonly string[]>({
    key: HANDS_OFF_DISMISSED_KEY,
    scope: `account`,
    // An unreadable list asks again rather than half-remembering.
    read: (raw) => (raw === null ? [] : (parseJsonWith(raw, DismissedSchema) ?? [])),
    write: (ids) => (ids.length === 0 ? null : JSON.stringify(ids)),
});

export interface OfferFacts {
    readonly canShip: boolean;
    readonly mode: SandboxMode | undefined;
    readonly override: Audience | undefined;
    readonly sandboxId: string | undefined;
    readonly dismissed: readonly string[];
}

/** Whether to ask: a maintainer who chose plain words on a sandbox that still runs hands-on, and has not said not now. */
export const offersHandsOff = ({ canShip, mode, override, sandboxId, dismissed }: OfferFacts): boolean =>
    canShip && mode === `hands-on` && override === `maker` && sandboxId !== undefined && !dismissed.includes(sandboxId);
