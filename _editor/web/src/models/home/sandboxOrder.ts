import { parseJsonWith } from "@intentic/base/json";
import { definePreference } from "@intentic/ui/preference";
import type { Ref } from "vue";
import { z } from "zod";

// THE READER'S OWN ORDER OF THEIR SANDBOXES, dragged into place on Home's rail (features/home/HomeSandboxes.vue) and
// worn by the door up to Home as well (otherSandboxes.ts). The ids in that order; empty until the reader arranges them,
// which leaves homeFacts.ts `orderedSandboxes` its own order. This device's, like the rail's pins (shell/rail/railPins.ts):
// chrome, not data.

const StoredOrderSchema = z.array(z.string());

// allow(module-state): one order per device, shared by every window through the preference channel
export const sandboxOrder: Ref<readonly string[]> = definePreference<readonly string[]>({
    key: `ui-sandbox-order`,
    // An unreadable payload is no arrangement: the default order rather than a half-parsed one.
    read: (raw) => (raw === null ? [] : (parseJsonWith(raw, StoredOrderSchema) ?? [])),
    write: (ids) => (ids.length === 0 ? null : JSON.stringify(ids)),
});

/** `ids` with the one at `from` taken out and put back at `to`, both indexes into `ids`. */
export const movedOrder = (ids: readonly string[], from: number, to: number): string[] => {
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) {
        next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
    }
    return next;
};
