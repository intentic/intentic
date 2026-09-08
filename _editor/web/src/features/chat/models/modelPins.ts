import type { ModelChoice } from "@intentic/sandbox-contract";
import { providerReady } from "../session/access";
import { modelOptionsFor, providerDisplayLabel } from "../accounts/providerCatalog";

// Naming a stored pin, shared by the settings rows that keep one (Quick model, Agent runs, the automatic tier's
// cheaper model): all draw the list the user wrote, not the resolved one. A pin whose account is disconnected
// stays visible, greyed, rather than disappearing, so this describes what the resolver has already discarded.

// Published label, falling back to the raw id: a pinned id the catalog hasn't caught up with has no label, and the
// id is more honest than nothing.
const modelPinLabel = (choice: ModelChoice): string =>
    modelOptionsFor(choice.provider).find((option) => option.value === choice.model)?.label ?? choice.model;

// What a resolved choice is called, provider included: a label like "GPT-OSS 120B" doesn't name its vendor, and
// the account a click spends is the point.
export const modelChoiceLabel = (choice: ModelChoice): string => `${providerDisplayLabel(choice.provider)} · ${modelPinLabel(choice)}`;

export interface DescribedPin {
    readonly choice: ModelChoice | undefined;
    readonly label: string;
    readonly ready: boolean;
}

// One entry of a stored list: the parsed pair when the list's own shape yielded one, raw text otherwise (two lists
// store `provider:model` keys, one stores full pins). A key that fails to parse still gets a row.
export const describePin = (choice: ModelChoice | undefined, raw: string): DescribedPin =>
    choice === undefined
        ? { choice: undefined, label: raw, ready: false }
        : { choice, label: modelChoiceLabel(choice), ready: providerReady(choice.provider) };
