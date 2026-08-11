import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import { isForticlientCiphertext } from "@intentic/sandbox-contract";
import { devFillGet, devFillSet } from "../../composables/devFill";
import { type FormValues, secretFields } from "./form";

/* DEV AUTOFILL FOR THE CAPABILITY FORM, and nowhere else in it.
 *
 * Local development resets sandboxes and databases constantly, and every reset used to mean re-pasting the same
 * tokens into the same cards. This remembers the secret fields of an add that WORKED and offers them back, keyed
 * per card because field keys like `token` repeat across the catalog. Inert in production, where devFillGet
 * answers undefined and devFillSet does nothing.
 *
 * Kept apart from ./form because it reads the browser: the rules there are plain functions of their arguments,
 * and dragging localStorage into them would make every one of them need a DOM to be read or tested. */

const keyOf = (entry: CapabilityCatalogEntry, fieldKey: string): string => `capability.${entry.id}.${fieldKey}`;

/* The remembered answers, as a patch over a freshly seeded form. A remembered value the daemon would NOW reject
 * is skipped — it was saved before the check existed, and silently re-offering it turns a convenience into a
 * confusing 400 on submit. */
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
