import { FIRE_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { streamAgent } from "../agent/agent.routes.js";
import { presentedDoorToken } from "../auth/door-tokens.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { dailyBudget } from "../store/daily-budget.js";
import { rateWindow } from "../store/rate-window.js";
import { remoteIpOf } from "./public-door.js";
import { fireAutomation, PAYLOAD_MAX } from "./scheduler.js";

/* POST /automations/:id/fire. Webhook fire for event automations: external systems (GitHub/Sentry/monitors)
 * POST here to wake the agent, authenticated by the door's own token (auth/door-tokens.ts), as `?token=…`, the
 * one mechanism every webhook sender supports, or as `authorization: Bearer …` from a caller that can set a
 * header and so keep the credential out of every log between it and this daemon. Enforced ALWAYS (fail-closed
 * even in loopback, unlike /enroll: a door with no credential admits nobody), which is why the route is exempt
 * from the bearer middleware in app.ts. The body (any format, capped) reaches the guard as AUTOMATION_PAYLOAD
 * and is appended to the wake prompt. Responds immediately; the agent turn runs detached, exactly like a
 * scheduler fire.
 *
 * TWO CEILINGS, the same pair every public door has (public-door.ts, gate.routes.ts): a rate window per
 * automation and caller address, so a monitor that flaps cannot fire ten wakes a second, and a daily budget per
 * automation, because a rate bounds the minute without bounding the day and every wake is billed to the owner.
 * Both refuse BEFORE anything is spent, and the daily one is spent last so a call refused for another reason
 * has not eaten a turn. */

// Arrivals a minute per automation and caller before the door answers 429. Generous for a webhook that
// legitimately bursts (a push fans out a few deliveries), tight against a loop.
const FIRE_RATE_MAX = 30;

const window = rateWindow(60_000);
const daily = dailyBudget();

// The refusal a ceiling answers with, or nothing when the call is admitted. Rate first and budget last, so a
// caller over the minute has not spent from the day.
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
        // A webhook is an outside message too, so its wake opens a surfaced conversation like a Discord mention's
        // does, the sender is a system, not a person, so the origin carries no author or channel.
        void fireAutomation(services, automation, streamAgent, {
            ...(payload === "" ? {} : { payload }),
            origin: { automationId: automation.id, provider: "webhook" },
            title: `Webhook: ${automation.id}`,
        }).catch((error: unknown) => services.logger.error({ err: error, automation: automation.id }, "automation run failed"));
        return c.json({ ok: true });
    };
