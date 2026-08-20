import type { Config } from "../env.config.js";
import { relayPlatform, type RelayedAnswer } from "../platform/pool-services.js";
import type { TransferAuthorization } from "./x402.js";

/* THE SIGNER RELAY, the daemon's door onto the platform's wallet signer, and the whole of what this
 * container may do about keys: ask for the wallet's ADDRESS, and ask for one SIGNATURE over one
 * fully-specified transfer authorization. The key itself never crosses this wire in either direction.
 *
 * The platform re-validates the owner's policy on every sign (per-payment ceiling, daily cap) against its
 * own ledger and refuses over-cap requests no matter what this container claims, the daemon's checks in
 * payment-offer.ts are the UX, the signer's are the guarantee, so a compromised sandbox can at worst spend
 * what the owner already delegated. Authenticated by the connect token, which names whose wallet signs and
 * which the agent's own grant never covers (auth/grants.ts). */

// Policy caps as the platform mirrors them, sent on ensure so the signer enforces the same numbers the
// owner set on the capability card, and re-sent on every apply so an edit propagates.
export interface WalletPolicyMirror {
    readonly perPaymentMaxUsd: string;
    readonly dailyCapUsd: string;
}

// POST /wallet/ensure, create-or-return the owner's wallet for `network`, and mirror the policy. Answers
// {address} or a refusal sentence (no platform, wallet signing not enabled there, secrets key unset).
export const relayWalletEnsure = (config: Config, network: string, policy: WalletPolicyMirror): Promise<RelayedAnswer> =>
    relayPlatform(config, "POST", "/wallet/ensure", JSON.stringify({ network, policy }));

export interface SignRequest {
    readonly network: string;
    readonly asset: string;
    // The EIP-712 domain the token verifies against, off the challenge, relayed so the platform signs what
    // the merchant's facilitator will actually check.
    readonly domainName: string;
    readonly domainVersion: string;
    readonly authorization: TransferAuthorization;
    // Display + audit facts for the platform's own ledger row: what this payment was, in the owner's terms.
    readonly amountUsd: string;
    readonly host: string;
}

// POST /wallet/sign, one EIP-712 signature over one EIP-3009 transferWithAuthorization. Answers
// {signature} or the platform's refusal (over a cap, unknown wallet, network mismatch), relayed verbatim.
export const relayWalletSign = (config: Config, request: SignRequest): Promise<RelayedAnswer> =>
    relayPlatform(config, "POST", "/wallet/sign", JSON.stringify(request));
