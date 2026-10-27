import { mintToken, revokeToken, tokenList, writeWalletPolicy } from "../world/apiTokens";
import { type PlatformRouter, refusePlatform } from "./serve";

// THE ACCOUNT'S KEYS: its API tokens, and the policy its wallet spends under (world/apiTokens.ts). Every token write answers
// with the list, which is the page's whole state.
export const tokenAnswers = {
    list: () => ({ tokens: tokenList() }),
    create: ({ label, scope }) => mintToken(label, scope) ?? refusePlatform(`You already hold 20 tokens; revoke one before making another.`, 429),
    revoke: ({ tokenId }) => {
        revokeToken(tokenId);
        return { tokens: tokenList() };
    },
} satisfies NonNullable<PlatformRouter[`token`]>;

export const walletAnswers = {
    setPolicy: (policy) => writeWalletPolicy(policy),
} satisfies NonNullable<PlatformRouter[`wallet`]>;
