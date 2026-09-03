import type { QuickModelChoice } from "@intentic/sandbox-contract";
import { providerReady } from "./access";
import { modelOptionsFor, providerDisplayLabel } from "./providerCatalog";

/* NAMING A STORED PIN, shared by the three settings rows that keep one (Quick model, Agent runs and the
 * automatic tier's cheaper model), because all of them draw the list THE USER WROTE rather than the one that
 * survived resolution, and all have to say the same thing about the same model.
 *
 * That difference is the reason these are not the resolvers: a pin whose account was disconnected drops out of
 * the chain the daemon walks, but stays on screen greyed, because a setting that vanished from view looks like
 * the app ate it. So the rows need a describer that answers for a pin the resolver has already discarded. */

// The model's published label, falling back to the raw id, a pinned id the catalog has not caught up with (the
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

/* One entry of a stored list, as a row reads it: the pair when the list's own shape yielded one, and the raw
 * text when it did not. Two of the three lists store `${provider}:${model}` keys and the third stores pins that
 * carry their run settings beside the pair (AgentRunPinSchema), so the caller does the decoding and this
 * answers for both.
 *
 * A KEY THAT DID NOT PARSE STILL GETS A ROW. Only a hand-edited settings file produces one, and dropping it
 * from the screen would look exactly like the app eating a setting somebody made. */
export const describePin = (choice: QuickModelChoice | undefined, raw: string): DescribedPin =>
    choice === undefined
        ? { choice: undefined, label: raw, ready: false }
        : { choice, label: modelChoiceLabel(choice), ready: providerReady(choice.provider) };
