import { parseJsonWith } from "@intentic/base/json";
import { definePreference } from "@intentic/ui/preference";
import type { SandboxSummary } from "@intentic/api-contract";
import type { Ref } from "vue";
import { z } from "zod";
import { switchableSandboxes } from "../sandbox/live/roster";
import { orderedSandboxes } from "./homeFacts";

// THE READER'S OWN ORDER OF THEIR SANDBOXES, dragged into place on Home's rail (features/home/HomeSandboxes.vue) or in
// the switcher (SandboxSwitcher.vue), and worn by every list of them: those two, Alt+1…9, the phone's menu and the door
// up to Home (otherSandboxes.ts). The ids in that order; empty until the reader arranges them,
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

/**
 * The sandboxes a reader can switch to (roster.ts `switchableSandboxes`), in their own order: the one list Home's rail,
 * the switcher, its Alt+1…9 and the phone's menu all draw, so a sandbox dragged into place is in that place everywhere.
 */
export const arrangedSandboxes = (rows: readonly SandboxSummary[]): SandboxSummary[] =>
    orderedSandboxes(switchableSandboxes(rows), sandboxOrder.value);
