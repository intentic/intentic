import type { AgentOrigin } from "@intentic/sandbox-contract";
import { needChannelOf, needChannelText } from "./need-channel.js";

// What a channel conversation hears when its agent asks a person for something, and which conversations hear it.

test("a channel a person started the conversation from hears it; a visitor's chat and a conversation with no channel do not", () => {
    const slack: AgentOrigin = { automationId: "slack-listener", provider: "slack", channelId: "C0123" };
    expect(needChannelOf(slack)).toEqual(slack);
    // A visitor is a stranger: nothing a need asks for is theirs to give.
    expect(needChannelOf({ automationId: "site-chat", provider: "webchat", channelId: "visitor-1" })).toBeUndefined();
    expect(needChannelOf({ automationId: "slack-listener", provider: "slack" })).toBeUndefined();
    expect(needChannelOf(undefined)).toBeUndefined();
});

test("the ask is said with the agent's case and where to answer it", () => {
    expect(needChannelText({ title: "Connect SSH for staging.acme.dev", why: "to read the signup service's logs", subject: { kind: "capability", entry: "ssh", name: "SSH", mode: "connect" } })).toBe(
        "Waiting on a person: Connect SSH for staging.acme.dev (to read the signup service's logs). Answer it in Intentic, in this conversation or under Needs you; the work that does not need it carries on meanwhile.",
    );
});

test("a secret's ask warns against pasting it into the channel", () => {
    expect(needChannelText({ title: "The STRIPE_SECRET_KEY secret", subject: { kind: "secret", name: "STRIPE_SECRET_KEY" } })).toBe(
        "Waiting on a person: The STRIPE_SECRET_KEY secret. Answer it in Intentic, in this conversation or under Needs you; the work that does not need it carries on meanwhile. " +
            "Please do not paste it here: its card in Intentic has a masked field for it, and anything sent here stays in this channel's history.",
    );
});
