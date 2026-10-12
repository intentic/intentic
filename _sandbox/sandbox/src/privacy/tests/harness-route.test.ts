import type { GatewaySession } from "../gateway/session-token.js";
import { shieldHarnessCredential } from "../harness-route.js";

// Which address a Claude Code turn's model requests go to: the shield's gateway while the shield is on or watching, and
// the provider itself otherwise.

const SHIELD_URL = "http://127.0.0.1:8787/privacy/gateway/shield";

const shieldWith = (on: boolean) => {
    const asked: GatewaySession[] = [];
    return {
        asked,
        shield: {
            baseUrlFor: async (session: GatewaySession) => {
                asked.push(session);
                return on ? SHIELD_URL : undefined;
            },
        },
    };
};

test("with the shield on, the turn goes to its gateway, which forwards to where the credential would have gone", async () => {
    const { shield, asked } = shieldWith(true);
    expect(await shieldHarnessCredential(shield, { kind: "container" }, { provider: "claude", conversationId: "c-1" })).toEqual({
        kind: "container",
        gateway: SHIELD_URL,
    });
    expect(asked).toEqual([{ provider: "claude", upstream: "https://api.anthropic.com", conversationId: "c-1" }]);
});

test("with the shield off, the credential is spent as it is", async () => {
    const { shield } = shieldWith(false);
    expect(await shieldHarnessCredential(shield, { kind: "container" }, { provider: "claude", conversationId: "c-1" })).toEqual({
        kind: "container",
    });
});
