import type { Config } from "../env.config.js";
import { relayPlatform, type RelayedAnswer } from "../platform/platform-relay.js";
import type { TransferAuthorization } from "./x402.js";

/* THE SIGNER RELAY, the daemon's door onto the platform's wallet signer, and the whole of what this
 * container may do about keys: ask for the wallet's ADDRESS, and ask for one SIGNATURE over one
 * fully-specified transfer authorization. The key itself never crosses this wire in either direction.
 *
 * The platform re-validates the owner's policy on every sign (per-payment ceiling, daily cap) against its
 * own ledger and refuses over-cap requests no matter what this container claims, the daemon's checks in
 * payment-offer.ts are the UX, the signer's are the guarantee, so a compromised sandbox can at worst spend
 * what the owner already delegated. Authenticated by the connect token, which names whose wallet signs and
 * which the agent's own grant never covers (auth/grants.ts).
 *
 * THE CAPS NEVER CROSS THIS WIRE. The card's two numbers are what THIS side checks and what its ledger reads;
 * the copy the signer enforces is written to the platform by the owner's browser, over their session, as the
 * card is saved. This relay used to mirror them on ensure, which made the container the author of its own
 * ceiling, exactly the party the ceiling exists to bound. */

// POST /wallet/ensure, create-or-return the owner's wallet for `network`. Answers {address} or a refusal
// sentence (no platform, wallet signing not enabled there, secrets key unset).
export const relayWalletEnsure = (config: Config, network: string): Promise<RelayedAnswer> =>
    relayPlatform(config, "POST", "/wallet/ensure", JSON.stringify({ network }));

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
    relayPlatform(config, "POST", "/wallet/sign", JSON.stringify(request));
