import type { AgentOrigin, Need } from "@intentic/sandbox-contract";
import { outboxKeyOf } from "../webchat/webchat-outbox.js";

// A need raised in a conversation that came from a channel (Slack, Telegram, Discord…) is said there too
// (docs/architecture/needs.md): the person who started it from the channel may never open the editor, and the card
// alone would leave them wondering why nothing happens. The answer itself is only ever given in Intentic, where the
// card's masked field and its verified identity are.

// A channel a person started the conversation from; never a visitor's chat, whose stranger can answer none of it.
export const needChannelOf = (origin: AgentOrigin | undefined): AgentOrigin | undefined =>
    origin?.channelId !== undefined && outboxKeyOf(origin) === undefined ? origin : undefined;

// The ask in words and where it is answered; for a secret, the one warning a channel needs, since the instinct is to
// paste it straight into the chat, where it would stay in the channel's history.
export const needChannelText = (need: Pick<Need, "title" | "why" | "subject">): string => {
    const why = need.why === undefined || need.why === "" ? "" : ` (${need.why})`;
    const paste =
        need.subject.kind === "secret"
            ? " Please do not paste it here: its card in Intentic has a masked field for it, and anything sent here stays in this channel's history."
            : "";
    return `Waiting on a person: ${need.title}${why}. Answer it in Intentic, in this conversation or under Needs you; the work that does not need it carries on meanwhile.${paste}`;
};
