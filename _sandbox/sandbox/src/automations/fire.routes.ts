import { FIRE_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { streamAgent } from "../agent/routes/agent.routes.js";
import { presentedDoorToken } from "../auth/door-tokens.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { dailyBudget } from "../store/daily-budget.js";
import { rateWindow } from "../store/rate-window.js";
import { remoteIpOf } from "./public-door.js";
import { fireAutomation, PAYLOAD_MAX } from "./scheduler.js";

// POST /automations/:id/fire wakes an event automation from a webhook, authenticated by the door token (`?token=` or
// `Authorization: Bearer`) and enforced even in loopback, unlike /enroll. The body reaches the guard as
// AUTOMATION_PAYLOAD; the route responds immediately while the agent turn runs detached.

// Arrivals per minute, per automation and caller, before 429; generous for bursts, tight against a loop.
const FIRE_RATE_MAX = 30;

const window = rateWindow(60_000);
const daily = dailyBudget();

// Refusal message from the first ceiling hit, or undefined if admitted. Rate checked before budget, so a caller over
// the minute never spends from the day.
const ceilingRefusal = (id: string, dailyMax: number | undefined, ip: string | undefined, now: number): string | undefined => {
    if (window.limited(`${id}:${ip ?? "?"}`, FIRE_RATE_MAX, now)) {
        return "rate limited";
    }
    return daily.spend(id, dailyMax ?? FIRE_DAILY_MAX_DEFAULT, now) ? "this webhook has reached today's limit" : undefined;
};

export const createAutomationFireRoute =
    (services: Services) =>
    async (c: Context<AppEnv, "/automations/:id/fire">): Promise<Response> => {
        const automation = await services.automations.get(c.req.param("id"));
        if (automation === undefined || automation.trigger.kind !== "event") {
            return c.json({ error: "no event automation with that id" }, 404);
        }
        if (!(await services.doorTokens.verify("automation", automation.id, presentedDoorToken(c.req.raw.headers, c.req.query("token"))))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        if (!automation.enabled) {
            return c.json({ error: "automation disabled" }, 409);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > PAYLOAD_MAX) {
            return c.json({ error: "payload too large" }, 413);
        }
        const refused = ceilingRefusal(automation.id, automation.trigger.dailyMax, remoteIpOf(c), Date.now());
        if (refused !== undefined) {
            return c.json({ error: refused }, 429);
        }
        const payload = await c.req.text();
        // Webhook wakes surface like a Discord mention; origin has no author or channel since the sender is a system.
        void fireAutomation(services, automation, streamAgent, {
            ...(payload === "" ? {} : { payload }),
            origin: { automationId: automation.id, provider: "webhook" },
            title: `Webhook: ${automation.id}`,
        }).catch((error: unknown) => services.logger.error({ err: error, automation: automation.id }, "automation run failed"));
        return c.json({ ok: true });
    };
