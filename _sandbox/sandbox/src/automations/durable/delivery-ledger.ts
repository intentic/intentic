import { join } from "node:path";
import { z } from "zod";
import type { Services } from "../../composition.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openEntries } from "../../store/open-document.js";

// The deliveries a signed webhook already took, by the id its provider gives each one (fire/webhook-signature.ts
// `deliveryIdOf`), so a redelivery (a retry after a slow answer, a "Redeliver" pressed in GitHub) answers `duplicate`
// instead of waking the agent twice. On the history volume, so a restart between a call and its retry still knows it.
// A row lives for WINDOW_MS, longer than any provider's retry schedule (Stripe's runs three days), and an automation
// keeps at most PER_AUTOMATION of them, its oldest going first.

const DELIVERY_WINDOW_MS = 4 * 24 * 60 * 60_000;
const PER_AUTOMATION = 2_000;

const deliveryEntry = z.object({ automationId: z.string(), id: z.string(), at: z.number() });
type DeliveryEntry = z.infer<typeof deliveryEntry>;

export const webhookDeliveriesDocument = defineDocument({
    root: "history",
    path: "automation-webhook-deliveries.json",
    // Ids alone, never a payload: a moved sandbox still recognises a retry of what it took before the move.
    portability: "carry",
    granularity: "entries",
    schema: deliveryEntry,
});

type Deps = Pick<Services, "config">;

const ledger = (services: Deps) => openEntries(webhookDeliveriesDocument, join(services.config.historyRoot, webhookDeliveriesDocument.path));

// What stays: rows inside the window, at most PER_AUTOMATION for `automationId`, newest kept.
const pruned = (entries: readonly DeliveryEntry[], automationId: string, now: number): DeliveryEntry[] => {
    const live = entries.filter((entry) => now - entry.at < DELIVERY_WINDOW_MS);
    const own = live.filter((entry) => entry.automationId === automationId);
    const over = own.length - PER_AUTOMATION;
    if (over <= 0) {
        return live;
    }
    const dropped = new Set(own.slice(0, over));
    return live.filter((entry) => !dropped.has(entry));
};

/** Whether this automation already took the delivery within the window. Reads only. */
export const deliverySeen = async (services: Deps, automationId: string, id: string, now: number): Promise<boolean> =>
    (await ledger(services).read()).some((entry) => entry.automationId === automationId && entry.id === id && now - entry.at < DELIVERY_WINDOW_MS);

/**
 * Records the delivery as taken; false when it already was, checked inside the same write so two copies of one
 * delivery arriving together cannot both be taken.
 */
export const claimDelivery = async (services: Deps, automationId: string, id: string, now: number): Promise<boolean> => {
    let claimed = false;
    await ledger(services).update((entries) => {
        const kept = pruned(entries, automationId, now);
        if (kept.some((entry) => entry.automationId === automationId && entry.id === id)) {
            return kept;
        }
        claimed = true;
        return pruned([...kept, { automationId, id, at: now }], automationId, now);
    });
    return claimed;
};

