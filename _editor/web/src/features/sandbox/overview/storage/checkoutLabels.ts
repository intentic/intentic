import type { CheckoutState } from "@intentic/sandbox-contract/schemas/metrics";
import { formatBytes } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import type { CheckoutPart } from "./checkoutsView";

// The words for a checkout's standing and its parts, said the same on the Disk card's rows and a board card's mark.

const STATE_LABEL = {
    working: () => t(`sandbox.storageCheckouts.working`),
    idle: () => t(`sandbox.storageCheckouts.idle`),
    held: () => t(`sandbox.storageCheckouts.held`),
    landed: () => t(`sandbox.storageCheckouts.landed`),
    archived: () => t(`sandbox.storageCheckouts.archived`),
    leftover: () => t(`sandbox.storageCheckouts.leftover`),
} satisfies Record<CheckoutState, () => string>;

export const checkoutStateLabel = (state: CheckoutState): string => STATE_LABEL[state]();

const PART_LABEL = {
    checkout: (bytes: string) => t(`sandbox.storageCheckouts.partCheckout`, { bytes }),
    buildOutput: (bytes: string) => t(`sandbox.storageCheckouts.partBuildOutput`, { bytes }),
    overlay: (bytes: string) => t(`sandbox.storageCheckouts.partOverlay`, { bytes }),
} satisfies Record<CheckoutPart[`kind`], (bytes: string) => string>;

export const checkoutPartLabel = (part: CheckoutPart): string => PART_LABEL[part.kind](formatBytes(part.bytes));
