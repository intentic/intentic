import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { isForticlientCiphertext } from "@intentic/sandbox-contract";
import { devFillGet, devFillSet } from "../../setup/devFill";
import { type FormValues, secretFields } from "./form";

// Dev autofill for the capability form: remembers a card's secret fields after a successful add and
// offers them back, keyed per card. Inert in production, where devFillGet/devFillSet are no-ops.
// Kept apart from ./form, which stays pure functions with no browser access.

const keyOf = (entry: CapabilityCatalogEntry, fieldKey: string): string => `capability.${entry.id}.${fieldKey}`;

// Remembered answers applied as a patch over a freshly seeded form; a value the daemon would now
// reject is skipped.
export const rememberedSecrets = (entry: CapabilityCatalogEntry): FormValues => {
    const values: FormValues = {};
    for (const field of secretFields(entry)) {
        const remembered = devFillGet(keyOf(entry, field.key));
        if (remembered !== undefined && !isForticlientCiphertext(remembered)) {
            values[field.key] = remembered;
        }
    }
    return values;
};

// Remember the secret fields that just worked, per card.
export const rememberSecrets = (entry: CapabilityCatalogEntry, values: FormValues): void => {
    for (const field of secretFields(entry)) {
        devFillSet(keyOf(entry, field.key), (values[field.key] ?? ``).trim());
    }
};
