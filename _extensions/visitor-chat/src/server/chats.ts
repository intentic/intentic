import type { AutomationSummary, WebchatConfig } from "@intentic/sandbox-contract/schemas/automations";

// THE CHATS: the automations listening on this extension's `webchat` source, each one chat on one or more sites. Their
// settings live on the automation itself (its `webchat` field, the trigger's `allowedOrigins`), which the owner edits in
// the Automations view and the sandbox validates on save; this backend only reads them, through the daemon's
// GET /automations (`permissions.daemon`). Read a few seconds stale at most: a conversation is one read, and a switched
// off chat is refused by the door itself before anything here runs.

// The listener provider this extension declares, which a chat's automation names.
export const WEBCHAT_PROVIDER = `webchat`;

export interface Chat {
    readonly id: string;
    readonly enabled: boolean;
    readonly allowedOrigins: readonly string[];
    readonly config: WebchatConfig;
}

export interface Chats {
    readonly get: (id: string) => Promise<Chat | undefined>;
    // In the automations' own order.
    readonly list: () => Promise<readonly Chat[]>;
}

/** The daemon's automations list, through the contract's typed client (`api.daemon.rpc.automations.list`), parsed there. */
export type ListAutomations = () => Promise<{ readonly automations: readonly AutomationSummary[] }>;

const FRESH_MS = 5_000;

/** The chats as the daemon lists them, re-read once they are a few seconds old. */
export const daemonChats = (listAutomations: ListAutomations, now: () => number = Date.now): Chats => {
    let cached: { readonly at: number; readonly chats: Promise<readonly Chat[]> } | undefined;
    const read = async (): Promise<readonly Chat[]> =>
        (await listAutomations()).automations.flatMap((automation): Chat[] =>
            automation.trigger.kind === `listener` && automation.trigger.provider === WEBCHAT_PROVIDER
                ? [{ id: automation.id, enabled: automation.enabled, allowedOrigins: automation.trigger.allowedOrigins ?? [], config: automation.webchat ?? {} }]
                : [],
        );
    const list = (): Promise<readonly Chat[]> => {
        if (cached === undefined || now() - cached.at > FRESH_MS) {
            const chats = read();
            cached = { at: now(), chats };
            // A failed read is not kept: the next asks again.
            chats.catch(() => {
                cached = undefined;
            });
        }
        return cached.chats;
    };
    return {
        get: async (id) => (await list()).find((chat) => chat.id === id),
        list,
    };
};
