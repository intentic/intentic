import { parsePinned, type QuickModelChoice } from "@intentic/sandbox-contract";
import { providerReady } from "./access";
import { modelOptionsFor, providerDisplayLabel } from "./providerCatalog";

/* NAMING A STORED `${provider}:${model}` PIN — shared by the two settings rows that keep one (Quick model and
 * Agent runs), because both draw the list THE USER WROTE rather than the one that survived resolution and both
 * have to say the same thing about the same key.
 *
 * That difference is the reason these are not the resolvers: a pin whose account was disconnected drops out of
 * the chain the daemon walks, but stays on screen greyed, because a setting that vanished from view looks like
 * the app ate it. So the rows need a describer that answers for a pin the resolver has already discarded. */

// The model's published label, falling back to the raw id — a pinned id the catalog has not caught up with (the
// picker's custom-model escape hatch) has no label to show, and showing the id is more honest than showing
// nothing.
const modelPinLabel = (choice: QuickModelChoice): string =>
    modelOptionsFor(choice.provider).find((option) => option.value === choice.model)?.label ?? choice.model;

// What a resolved choice is CALLED, provider included: "Claude Haiku 4.5" already names its vendor, but
// "GPT-OSS 120B" on Google's channel does not, and which account a click spends is the point of naming it.
export const modelChoiceLabel = (choice: QuickModelChoice): string => `${providerDisplayLabel(choice.provider)} · ${modelPinLabel(choice)}`;

export interface DescribedPin {
    readonly choice: QuickModelChoice | undefined;
    readonly label: string;
    readonly ready: boolean;
}

// One entry of a stored list, as a person reads it. Falls back to the raw key for a malformed one, which is what
// a hand-edited settings file can hold.
export const describeModelPin = (key: string): DescribedPin => {
    const choice = parsePinned(key);
    if (choice === undefined) {
        return { choice: undefined, label: key, ready: false };
    }
    return { choice, label: modelChoiceLabel(choice), ready: providerReady(choice.provider) };
};
