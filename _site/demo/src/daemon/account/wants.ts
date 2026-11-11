import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { STARTED_AT } from "../board/roster";

// What agents asked the owner's computers for by place (`secrets want`) and nobody has answered yet: the Secrets view's
// "Needs attention" rows and its badge. The keyring entries already shared here (the bank PIN, the VPN login on rog)
// are in the secret inventory beside every other secret.

export const demoWants = (): SandboxHandlerOutput<`secrets`, `wants`> => ({
    needs: [
        {
            id: `need-stripe-dashboard`,
            origin: { kind: `site`, host: `dashboard.stripe.com` },
            username: `ada@acme.dev`,
            detail: `Check last night's refunds in the Stripe dashboard`,
            conversation: `refund-audit`,
            machine: `rog`,
            state: `pending`,
            at: STARTED_AT - 6 * 60_000,
        },
    ],
});
