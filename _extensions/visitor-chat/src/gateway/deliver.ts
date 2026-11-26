import { GatewayRefusal } from "@intentic/connector-runtime";
import type { Chats } from "../server/chats.js";
import { type Outbox, outboxKeyOf } from "../server/outbox.js";
import { automationOfThread } from "../server/wake.js";

// The chat a reply is for. `channelId` is the visitor's conversation and `thread` names the chat (wake.ts). A conversation
// the daemon opened itself before 2026-11-26 names no thread: its chat is the one its visitor already has replies waiting
// under, else the sandbox's only Visitor chat. With several and nothing waiting, nothing says which, and the refusal says
// so where the owner reads why a reply did not go.
const chatFor = async (outbox: Outbox, chats: Pick<Chats, `list`>, channelId: string, thread: string | undefined): Promise<string> => {
    const named = automationOfThread(thread) ?? (await outbox.chatOf(channelId));
    if (named !== undefined) {
        return named;
    }
    const all = await chats.list();
    const [only] = all;
    if (all.length === 1 && only !== undefined) {
        return only.id;
    }
    throw new GatewayRefusal(`this visitor's conversation is older than the Visitor chat extension and names no chat, so its reply has no visitor to reach`);
};

export const deliverToOutbox =
    (outbox: Outbox, chats: Pick<Chats, `list`>, now: () => number = Date.now) =>
    async (channelId: string, text: string, thread?: string): Promise<void> => {
        await outbox.append(outboxKeyOf(await chatFor(outbox, chats, channelId, thread), channelId), text, now());
    };
