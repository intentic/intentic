import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { PRIVACY_SHIELDED_MAX, type PrivacyShieldedValue } from "@intentic/sandbox-contract/schemas/privacy";
import type { PrivacyShield } from "./privacy-shield.js";

// The words in a conversation's replies its model never read. While the shield masks a provider, that model reads every
// personal value as a token and writes the token back where it means the value; the gateway puts the value in before
// anyone sees the reply. In the chat that reads as the model knowing a name it was never told, so the chat marks each one
// (privacy.shielded). A value the vault holds can stand in such a reply only as a restored token: the model never had
// it to write. Replies only: a person's own words and a tool's output are theirs, not the model's.

export interface ShieldedDeps {
    readonly shield: Pick<PrivacyShield, "decide" | "policy" | "masker">;
    // The provider the conversation runs on, or undefined for one the registry does not know.
    readonly provider: (conversationId: string) => string | undefined;
    readonly rows: (conversationId: string) => Promise<readonly TranscriptRow[]>;
}

export const shieldedInReplies = async (deps: ShieldedDeps, conversationId: string): Promise<PrivacyShieldedValue[]> => {
    const provider = deps.provider(conversationId);
    if (provider === undefined) {
        return [];
    }
    // The verdict as it stands: a provider the owner has since trusted reads values from now on, and its replies are its own words.
    const { policy, verdict } = await deps.shield.decide({ provider, conversationId, route: "gateway" });
    if (verdict.kind !== "mask") {
        return [];
    }
    const masker = await deps.shield.masker(policy);
    const found = new Map<string, PrivacyShieldedValue>();
    for (const row of await deps.rows(conversationId)) {
        if (row.role !== "assistant" || row.text === "") {
            continue;
        }
        for (const span of await masker.known(row.text)) {
            const text = row.text.slice(span.start, span.end);
            found.set(text, { text, token: span.token, class: span.class });
            if (found.size >= PRIVACY_SHIELDED_MAX) {
                return [...found.values()];
            }
        }
    }
    return [...found.values()];
};
