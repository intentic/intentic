import type { Services } from "../../composition.js";
import { actionRefusal } from "../../guard/outbound-guard.js";
import { opt } from "../../opt.js";
import type { S2sAsker } from "../askers.js";
import type { ContactRow } from "../contacts/contacts-store.js";

// AN AGENT'S SEND IS AN OUTWARD ACTION (docs/architecture/messages.md, "Sending"): the guard decides it as it decides a
// channel message, under the owner's action rules (`messages.message.send`, or `messages.*`), and it leaves the same
// Activity row a channel message does. A person's own send from the editor is theirs, and is neither gated nor recorded.

// The action's key in the owner's rules: `<provider>.<type>`.
export const S2S_SEND_ACTION = { provider: "messages", type: "message.send" } as const;

export interface SendGuard {
    // The owner's rules on an agent's send: a deny's reason or a hold's redirect, else undefined.
    readonly refusal: () => Promise<string | undefined>;
    // The Activity row for an agent's send, refused or queued.
    readonly record: (asker: Extract<S2sAsker, { kind: "turn" }>, row: ContactRow, text: string, refused: string | undefined) => void;
}

export const sendGuardOf = (services: Pick<Services, "sandboxSettings" | "activity" | "logger">): SendGuard => ({
    refusal: async () => actionRefusal((await services.sandboxSettings.get()).actionRules, S2S_SEND_ACTION),
    record: (asker, row, text, refused) => {
        void services.activity
            .append({
                provider: S2S_SEND_ACTION.provider,
                direction: "out",
                type: S2S_SEND_ACTION.type,
                channelId: row.address,
                content: text,
                conversationId: asker.conversationId,
                ...opt("outcome", refused === undefined ? undefined : ("error" as const)),
                ...opt("error", refused),
            })
            .catch((error: Error) => services.logger.warn({ err: error }, "activity append failed"));
    },
});
