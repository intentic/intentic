import type { Config } from "../env.config.js";
import { callPlatform, type RelayedAnswer } from "../platform/platform-relay.js";
import type { TransferAuthorization } from "./x402.js";

/* The signer relay exposes only the wallet address to the daemon. */

// POST /wallet/ensure, create-or-return the owner's wallet for `network`. Answers {address} or a refusal
// sentence (no platform, wallet signing not enabled there, secrets key unset).
export const relayWalletEnsure = (config: Config, network: string): Promise<RelayedAnswer> =>
    callPlatform(config, {
        method: "POST",
        path: "/wallet/ensure",
        payload: JSON.stringify({ network }),
        auth: { kind: "connect" },
        unreached: "nothing was charged",
    });

export interface SignRequest {
    readonly network: string;
    readonly asset: string;
    // The EIP-712 domain off the challenge, relayed so the platform signs what the facilitator will check.
    readonly domainName: string;
    readonly domainVersion: string;
    readonly authorization: TransferAuthorization;
    // Display + audit facts for the platform's own ledger row: what this payment was, in the owner's terms.
    readonly amountUsd: string;
    readonly host: string;
}

// POST /wallet/sign: one EIP-712 signature over one EIP-3009 transferWithAuthorization; answers `{signature}` or the
// platform's refusal, relayed verbatim.
export const relayWalletSign = (config: Config, request: SignRequest): Promise<RelayedAnswer> =>
    callPlatform(config, {
        method: "POST",
        path: "/wallet/sign",
        payload: JSON.stringify(request),
        auth: { kind: "connect" },
        unreached: "nothing was charged",
    });
