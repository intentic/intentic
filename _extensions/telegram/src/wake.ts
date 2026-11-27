import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "@intentic/connector-runtime";
import type { ExtensionProcessApi } from "@intentic/extension-api/runtime";
import { z } from "zod";
import { ALLOWED_UPDATES, type TelegramConnection } from "./client.js";

// HEARING A BOT WHILE A HOSTED SANDBOX SLEEPS (2026-11-27). The gateway long-polls while the sandbox is awake. Right
// before a sandbox the platform hosts goes to sleep, every bot it polls is pointed at the sandbox's wake door instead
// (`setWebhook`): Telegram's next delivery there wakes the machine and is answered 503, so Telegram keeps the update
// and tries again. Before a bot's first poll after that, the gateway deletes the webhook, keeping what Telegram queued,
// but only while it is still the one this sandbox set, and polls from Telegram's queue: `getUpdates` hands over what
// arrived while it slept. The door itself dispatches nothing (server.ts); polling stays the one way in.

// The public route the manifest declares with `wakes: true`.
export const WAKE_ROUTE = "wake";
// Where Telegram sends a webhook's `secret_token` back with every delivery.
export const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";
// How long past a before-sleep hook's deadline the gateway waits for the stop before it takes the sleep for one that never
// came and polls again, which clears the webhook it set.
const SLEEP_NEVER_CAME_MS = 120_000;

type BotCall = TelegramConnection["call"];

// A bot's numeric id, the part of its token before the colon, which Telegram shows anyone (getMe's `id`); undefined for a
// token not shaped like one.
const botIdOf = (botToken: string): string | undefined => /^(\d+):/u.exec(botToken)?.[1];

// The `secret_token` a bot's wake webhook carries: the bot's id, so the door can tell which bot a delivery is for, then an
// HMAC keyed by the bot's token, which nobody without the token can make. Telegram takes 1 to 256 of A-Z a-z 0-9 _ -.
export const webhookSecret = (botToken: string): string =>
    `${botIdOf(botToken) ?? "0"}_${createHmac("sha256", botToken).update("intentic-telegram-wake").digest("base64url")}`;

const sameSecret = (expected: string, presented: string): boolean => {
    const left = Buffer.from(expected);
    const right = Buffer.from(presented);
    return left.length === right.length && timingSafeEqual(left, right);
};

// What the wake door makes of a call, each answered its own way (server.ts). `ours`: Telegram delivering for one of this
// sandbox's bots, which polling picks up. `wrong`: a secret naming one of its bots that the bot's token did not make (a
// stranger, or a webhook set under a token since replaced). `gone`: a bot none of this sandbox's cards holds any more.
// `stranger`: no secret, or none shaped like ours.
export type WakeCall = "ours" | "wrong" | "gone" | "stranger";

export const judgeWakeCall = (presented: string | null, botTokens: readonly string[]): WakeCall => {
    const id = presented === null ? undefined : /^(\d+)_[\w-]+$/u.exec(presented)?.[1];
    if (presented === null || id === undefined) {
        return "stranger";
    }
    const same = botTokens.filter((token) => botIdOf(token) === id);
    if (same.length === 0) {
        return "gone";
    }
    return same.some((token) => sameSecret(webhookSecret(token), presented)) ? "ours" : "wrong";
};

// A wake URL as a door: its origin and path, without the `?wake=` secret, so nothing secret is written down.
const doorOf = (url: string): string | undefined => {
    const parsed = URL.parse(url);
    return parsed === null ? undefined : `${parsed.origin}${parsed.pathname}`;
};

// The bots this sandbox pointed at its wake door, by bot id, each with the door it was pointed at. A bot stays here until
// a start has looked at its webhook again, however many sleeps that takes.
export const ParkedSchema = z.record(z.string(), z.string());
export type Parked = z.infer<typeof ParkedSchema>;

// The slice of the extension api's JSON document the record writes through (`ctx.api.document`).
export interface ParkedDocument {
    readonly read: () => Promise<Parked>;
    readonly update: (change: (current: Parked) => Parked) => Promise<Parked>;
}

export interface WakeWebhooksDeps {
    readonly parked: ParkedDocument;
    // This sandbox's URL for the wake route (`api.sleep.wakeUrl`), which rejects on a sandbox with no public address.
    readonly wakeUrl: () => Promise<string>;
    readonly log: Pick<Logger, "info" | "warn">;
}

export interface WakeWebhooks {
    // Before a hosted sleep: each bot pointed at the wake door, written down first. Never rejects.
    readonly park: (bots: readonly Pick<TelegramConnection, "botToken" | "username" | "call">[]) => Promise<void>;
    // Before a bot's first poll: this sandbox's own webhook deleted, keeping what Telegram queued, and never anyone else's.
    // Answers whether to poll from Telegram's queue (the bot slept pointed at the door) rather than from now. `conflict`:
    // Telegram refused the poll 409, so some webhook is set, and one at this sandbox's door is cleared even where nothing
    // was written down. Asks nothing for a bot never pointed at the door unless `conflict`.
    readonly reclaim: (botToken: string, call: BotCall, conflict: boolean) => Promise<boolean>;
}

export const wakeWebhooks = ({ parked, wakeUrl, log }: WakeWebhooksDeps): WakeWebhooks => {
    // The URL is the same on every ask and after every restart (extension-api's `sleep.wakeUrl`), so one answer serves.
    let known: string | undefined;
    const ownUrl = async (): Promise<string> => {
        known ??= await wakeUrl();
        return known;
    };
    const ownDoor = (): Promise<string | undefined> =>
        ownUrl().then(doorOf, (error: Error) => {
            log.warn({ err: error }, "telegram: this sandbox's wake URL could not be read");
            return undefined;
        });
    const forget = (id: string): Promise<void> =>
        parked
            .update((current) => Object.fromEntries(Object.entries(current).filter(([each]) => each !== id)))
            .then(
                () => undefined,
                (error: Error) => log.warn({ err: error }, "telegram: the record of a bot pointed at the wake door was not cleared"),
            );

    return {
        park: async (bots) => {
            if (bots.length === 0) {
                return;
            }
            const url = await ownUrl().catch((error: Error) => {
                log.warn({ err: error }, "telegram: no wake URL, so messages sent while the sandbox sleeps wait until it is opened");
                return undefined;
            });
            const door = url === undefined ? undefined : doorOf(url);
            if (url === undefined || door === undefined) {
                return;
            }
            // Written down before Telegram is asked, so a webhook whose answer never came back is still looked at on start.
            // A record that cannot be written still parks the bots: the start finds the webhook at this sandbox's door when
            // Telegram refuses its poll 409.
            const ids = bots.flatMap(({ botToken }) => botIdOf(botToken) ?? []);
            await parked
                .update((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, door])) }))
                .catch((error: Error) => log.warn({ err: error }, "telegram: the bots pointed at the wake door were not written down"));
            await Promise.all(
                bots.map(async (bot) => {
                    try {
                        // `drop_pending_updates` stays false: what arrives from here on waits at Telegram for the next poll.
                        await bot.call("setWebhook", { url, secret_token: webhookSecret(bot.botToken), allowed_updates: ALLOWED_UPDATES });
                        log.info({ bot: bot.username }, "telegram: bot pointed at the wake door while the sandbox sleeps");
                    } catch (error) {
                        log.warn({ err: error, bot: bot.username }, "telegram: the wake webhook was not set, so messages sent while the sandbox sleeps wait until it is opened");
                    }
                }),
            );
        },
        reclaim: async (botToken, call, conflict) => {
            const id = botIdOf(botToken);
            const stored = id === undefined ? undefined : (await parked.read())[id];
            const doors = new Set([stored, conflict ? await ownDoor() : undefined].filter((door) => door !== undefined));
            if (doors.size === 0) {
                return false;
            }
            const info = await call<{ readonly url?: string }>("getWebhookInfo");
            const set = info.url ?? "";
            const setDoor = set === "" ? undefined : doorOf(set);
            const ours = setDoor !== undefined && doors.has(setDoor);
            if (ours) {
                await call("deleteWebhook", { drop_pending_updates: false });
            }
            if (stored !== undefined && id !== undefined) {
                await forget(id);
            }
            // Someone else's webhook stays where it is: the poll that follows is refused 409, as it always was.
            return ours || (stored !== undefined && set === "");
        },
    };
};

// The gateway's pool as the sleep meets it: the bots it polls now, and how one's poll is stopped.
export interface SleepPool {
    readonly bots: () => readonly Pick<TelegramConnection, "botToken" | "username" | "call">[];
    readonly close: (botToken: string) => void;
}

// The gateway's side of a hosted sleep: right before it, every poll stops and its bot is pointed at the wake door. Answers
// whether the gateway is past that point, when nothing may open again, since a poll would clear the webhook the sleep
// depends on; a sleep that has not come `neverCameMs` past its deadline lets polling start again. Never told on a sandbox
// that does not sleep (one on somebody's own computer), where nothing changes.
export const parkBeforeSleep = (
    sleep: Pick<ExtensionProcessApi["sleep"], "beforeSleep">,
    wake: Pick<WakeWebhooks, "park">,
    pool: SleepPool,
    neverCameMs = SLEEP_NEVER_CAME_MS,
): (() => boolean) => {
    let asleep = false;
    sleep.beforeSleep(async ({ deadline }) => {
        asleep = true;
        setTimeout(
            () => {
                asleep = false;
            },
            Math.max(0, deadline - Date.now()) + neverCameMs,
        ).unref();
        const bots = pool.bots();
        // Each poll stops first, so Telegram ending it for the webhook is not read as another reader taking the bot.
        for (const bot of bots) {
            pool.close(bot.botToken);
        }
        await wake.park(bots);
    });
    return () => asleep;
};
