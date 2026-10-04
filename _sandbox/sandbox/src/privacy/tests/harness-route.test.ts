import type { GatewaySession } from "../gateway/session-token.js";
import { shieldHarnessCredential } from "../harness-route.js";

// Which address a Claude Code turn's model requests go to: the shield's gateway while the shield is on or watching,
// the same gateway as a relay that only clears when the conversation drew the clearing arm with the shield off, and
// the provider itself otherwise. The gateway session says whether to clear, whichever way it was reached.

const SHIELD_URL = "http://127.0.0.1:8787/privacy/gateway/shield";
const RELAY_URL = "http://127.0.0.1:8787/privacy/gateway/relay";

const shieldWith = (on: boolean) => {
    const asked: GatewaySession[] = [];
    return {
        asked,
        shield: {
            baseUrlFor: async (session: GatewaySession) => {
                asked.push(session);
                return on ? SHIELD_URL : undefined;
            },
            relayUrlFor: async (session: GatewaySession) => {
                asked.push(session);
                return RELAY_URL;
            },
        },
    };
};

test("with the shield on, the turn goes to its gateway, and the session carries the clearing arm", async () => {
    const { shield, asked } = shieldWith(true);
    expect(await shieldHarnessCredential(shield, { kind: "container" }, { provider: "claude", conversationId: "c-1", clearing: true })).toEqual({
        kind: "container",
        gateway: SHIELD_URL,
    });
    expect(asked).toEqual([{ provider: "claude", upstream: "https://api.anthropic.com", conversationId: "c-1", clearing: true }]);
});

test("with the shield off, a conversation in the clearing arm goes through the gateway as a relay that only clears", async () => {
    const { shield, asked } = shieldWith(false);
    expect(await shieldHarnessCredential(shield, { kind: "container" }, { provider: "claude", conversationId: "c-1", clearing: true })).toEqual({
        kind: "container",
        gateway: RELAY_URL,
        clearingOnly: true,
    });
    expect(asked.at(-1)).toEqual({ provider: "claude", upstream: "https://api.anthropic.com", conversationId: "c-1", clearing: true });
});

test("with the shield off and no clearing, the credential is spent as it is", async () => {
    const { shield } = shieldWith(false);
    expect(await shieldHarnessCredential(shield, { kind: "container" }, { provider: "claude", conversationId: "c-1" })).toEqual({
        kind: "container",
    });
});
