import { type RunnerWakeAnswer, RunnerWakeRequestSchema } from "@intentic/sandbox-contract/protocol/doors/runner-wake";
import type { Context } from "hono";
import type { Services } from "../../composition.js";
import { conversationProfile, worktreeOf } from "../../conversations/registry/agents-store.js";
import { opt } from "../../opt.js";
import { bearerPeer } from "../../peers/peer-store.js";
import { deliverWake } from "../../seams/wake-delivery.js";

// The parent's half of a runner's wake (wake.ts has why): POST /system/runners/wake, on the runner's own bearer.

/** The parent's side: says a runner's wake into a conversation dispatched to that runner, as its own wake. */
export const createRunnerWakeRoute =
    (services: Pick<Services, "runners" | "agents" | "turns" | "logger">) =>
    async (c: Context): Promise<Response> => {
        const runner = await bearerPeer(services.runners, c);
        if (runner instanceof Response) {
            return runner;
        }
        // allow(silent-catch): a body that is not JSON is answered as the invalid request it is, just below.
        const body = RunnerWakeRequestSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
            return c.json({ error: "invalid request" }, 400);
        }
        const wake = body.data;
        const entry = services.agents.entry(wake.conversationId);
        // Only a conversation placed on the runner asking: a runner reaches no other conversation through this door.
        if (entry === undefined || worktreeOf(entry)?.runner !== runner) {
            return c.json({ forwarded: false } satisfies RunnerWakeAnswer);
        }
        const said = await deliverWake(
            { turns: services.turns },
            {
                conversationId: wake.conversationId,
                prompt: wake.prompt,
                voice: wake.voice,
                ...opt("outside", wake.outside),
                ...opt("errand", wake.errand),
                source: wake.source === undefined ? `runner:${runner}` : `runner:${runner}:${wake.source}`,
                ...opt("messageId", wake.messageId),
                profile: conversationProfile(entry),
            },
        );
        services.logger.info({ runner, conversationId: wake.conversationId, said: "delivered" in said ? said.delivered : said }, "runner: wake said here");
        return c.json({ forwarded: true, said } satisfies RunnerWakeAnswer);
    };
