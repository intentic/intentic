import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { ErrorFrame, FailureContext, FailureQueries } from "./classify-failure.js";

// Google's sentence for an account it stopped serving until its owner verifies it (403, VALIDATION_REQUIRED).
const ASKS_VERIFICATION = /^verify your account to continue\.?$/i;

// How many sign-ins the sentence names before it counts the rest: enough to recognise, short enough to read.
const NAMED_ACCOUNTS = 3;

// "a@x, b@y and 4 more": the names a reader recognises, then how many are left.
const accountList = (labels: readonly string[]): string => {
    const shown = labels.slice(0, NAMED_ACCOUNTS);
    const rest = labels.length - shown.length;
    if (rest > 0) {
        return `${shown.join(", ")} and ${String(rest)} more`;
    }
    return shown.length === 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1) ?? ""}`;
};

// Google's "Verify your account to continue." names no account, and on a routed turn the proxy picked it: the reader
// is told which accounts are waiting on them and where each one's verify link is. The provider's sentence stays when
// the translator has not benched any yet, since then there is nothing more true to say.
export const namedVerification = async (event: ErrorFrame, context: FailureContext, queries: FailureQueries): Promise<ErrorFrame> => {
    // allow(dependency-text): Google's "Verify your account to continue." as the translator relays it carries no code of its own; an unmatched wording keeps the provider's sentence as it came.
    if (!ASKS_VERIFICATION.test(event.message.trim()) || !KeyedProviderSchema.safeParse(context.provider).success) {
        return event;
    }
    const labels = await queries.awaitingVerification(context.provider).catch((): readonly string[] => []);
    if (labels.length === 0) {
        return event;
    }
    const subject = labels.length === 1 ? "an account" : `${String(labels.length)} accounts`;
    return {
        ...event,
        own: true,
        message: `Google wants ${subject} verified before ${labels.length === 1 ? "it takes" : "they take"} turns again: ${accountList(labels)}. Open Sandbox ▸ Agent and follow the Verify link on ${labels.length === 1 ? "its row" : "each row"}.`,
    };
};
