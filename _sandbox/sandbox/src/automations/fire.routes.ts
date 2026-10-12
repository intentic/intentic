import { FIRE_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { presentedDoorToken } from "../auth/tokens/door-tokens.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { readBoundedText } from "../http/bounded-body.js";
import { remoteIpOf } from "../http/remote-ip.js";
import { doorAdmission } from "./door-admission.js";
import { fireAutomation, PAYLOAD_MAX } from "./scheduler.js";

// POST /automations/:id/fire wakes an event automation from a webhook, authenticated by the door token (`?token=` or
// `Authorization: Bearer`) and enforced even in loopback, unlike /enroll. The body reaches the guard as
// AUTOMATION_PAYLOAD; the route responds immediately while the agent turn runs detached.

// Arrivals per minute, per automation and caller, before 429; generous for bursts, tight against a loop.
const FIRE_RATE_MAX = 30;

const admission = doorAdmission();

// Refusal message from the first ceiling hit, or undefined if admitted.
const ceilingRefusal = (id: string, dailyMax: number | undefined, ip: string | undefined, now: number): string | undefined => {
    const refused = admission.admit({ rateKey: `${id}:${ip ?? "?"}`, rateMax: FIRE_RATE_MAX, automationId: id, dailyMax: dailyMax ?? FIRE_DAILY_MAX_DEFAULT }, now);
    if (refused === undefined) {
        return undefined;
    }
    return refused === "rate" ? "rate limited" : "this webhook has reached today's limit";
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
        // Read before the ceilings, counted as it streams: a chunked body declares no length, and reading it whole
        // first is what the limit exists to prevent. An oversized call spends nothing from the day.
        const body = await readBoundedText(c.req.raw, PAYLOAD_MAX);
        if (body.kind === "tooLarge") {
            return c.json({ error: "payload too large" }, 413);
        }
        if (body.kind === "invalid") {
            return c.json({ error: "the body is not UTF-8 text" }, 400);
        }
        const refused = ceilingRefusal(automation.id, automation.trigger.dailyMax, remoteIpOf(c), Date.now());
        if (refused !== undefined) {
            return c.json({ error: refused }, 429);
        }
        const payload = body.value;
        // Webhook wakes surface like a Discord mention; origin has no author or channel since the sender is a system.
        void fireAutomation(services, automation, {
            ...(payload === "" ? {} : { payload }),
            origin: { automationId: automation.id, provider: "webhook" },
            title: `Webhook: ${automation.id}`,
        }).catch((error: unknown) => services.logger.error({ err: error, automation: automation.id }, "automation run failed"));
        return c.json({ ok: true });
    };
