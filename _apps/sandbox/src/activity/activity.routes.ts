import { activityContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { discordGatewayState } from "../discord/client.js";
import { activeVoiceSession } from "../discord/voice.js";

// The agent-activity audit feed. `list` reads the daemon-written log; `status` is a live probe — gateway
// state straight from the discord client pool, lastError from the recent log, plus the active voice session.
export const createActivityRoutes = (services: Services) => {
    const i = implement(activityContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async ({ input }) => ({ events: await services.activity.list(input) })),
        status: i.status.handler(async () => {
            const capabilities = await services.capabilities.list();
            // ponytail: lastError is provider-level from a recent-log scan (multiple bots share it); per-token
            // attribution if multi-bot error triage ever matters.
            const recent = await services.activity.list({ provider: "discord", limit: 100 });
            const lastError = recent.find((event) => event.direction === "system" && event.error !== undefined)?.error;
            const connections = capabilities.flatMap((capability) =>
                capability.kind === "cli" && capability.config.provider === "discord"
                    ? [
                          {
                              capabilityId: capability.id,
                              provider: "discord",
                              gateway: discordGatewayState(capability.config.botToken),
                              ...(lastError !== undefined ? { lastError } : {}),
                          },
                      ]
                    : [],
            );
            const voice = activeVoiceSession();
            return { connections, ...(voice !== undefined ? { voice } : {}) };
        }),
    };
};
