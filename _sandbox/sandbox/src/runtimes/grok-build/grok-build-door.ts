import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { GROK_BUILD } from "./grok-build-cli.js";

// Grok's one account door (/accounts/grok) over its two sign-ins: OpenCode's xAI login, which its default loop spends,
// and Grok Build's own CLI login, which the `vendor` loop spends. A start names which by its variant (the CLI loop's door,
// LoopOffer.door), and every row the CLI's half lists carries that variant, so a row, a rename or a disconnect reaches
// the half that holds it. They are separate connections: signing in to one never signs in the other.

export const grokDoors = (opencode: AccountDoor, cli: AccountDoor, holdsCli: (id: string) => Promise<boolean>): AccountDoor => ({
    start: (variant) => (variant === GROK_BUILD.door ? cli.start(variant) : opencode.start(variant)),
    // Only the CLI's half keeps a record of its attempts; OpenCode's finishes into its account list.
    status: (handshake) => cli.status?.(handshake) ?? { status: "error", error: "That sign-in is watched through the account list." },
    cancel: (handshake) => {
        cli.cancel(handshake);
        opencode.cancel(handshake);
    },
    list: async (force) => [...(await opencode.list(force)), ...(await cli.list(force))],
    rename: async (id, label) => ((await holdsCli(id)) ? cli.rename(id, label) : opencode.rename(id, label)),
    // OpenCode holds one xAI sign-in, so its row has no identity to match; the CLI's rows are matched as anyone's are.
    identityOf: (stored) => (stored.variant === GROK_BUILD.door ? cli.identityOf(stored) : undefined),
    forget: async (id) => ((await holdsCli(id)) ? cli.forget(id) : opencode.forget(id)),
});
