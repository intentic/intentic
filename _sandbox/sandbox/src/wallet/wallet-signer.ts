import type { WalletSignBody } from "@intentic/api-contract/ingress";
import type { Config } from "../env.config.js";
import type { CliAnswer } from "../http/cli-answer.js";
import { callPlatform } from "../system/platform-relay.js";

/* The signer relay exposes only the wallet address to the daemon. */

// POST /wallet/ensure, create-or-return the owner's wallet for `network`. Answers {address} or a refusal
// sentence (no platform, wallet signing not enabled there, secrets key unset).
export const relayWalletEnsure = (config: Config, network: string): Promise<CliAnswer> =>
    callPlatform(config, { route: "walletEnsure", input: { network }, unreached: "nothing was charged" });

// The EIP-712 domain off the challenge, relayed so the platform signs what the facilitator will check, and the amount
// and host for the platform's own ledger row: what this payment was, in the owner's terms.
export type SignRequest = WalletSignBody;

// POST /wallet/sign: one EIP-712 signature over one EIP-3009 transferWithAuthorization; answers `{signature}` or the
// platform's refusal, relayed verbatim.
export const relayWalletSign = (config: Config, request: SignRequest): Promise<CliAnswer> =>
    callPlatform(config, { route: "walletSign", input: request, unreached: "nothing was charged" });
