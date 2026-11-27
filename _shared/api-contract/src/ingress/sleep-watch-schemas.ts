import { z } from "zod";
import { IngressOkSchema } from "./ingress-schemas.js";

/* SLEEP WATCHES (2026-11-27): the one exception to credentials staying in the sandbox. Discord delivers a mention only
 * over a live gateway connection, so a hosted sandbox that sleeps hears none unless something outside it holds that
 * connection. For each connection whose owner turned the card's consent switch on, and only while an automation listens
 * on it, the daemon hands the bot's token to the platform right before the machine stops (`sleepWatch`). The platform
 * keeps it encrypted, holds the gateway connection, records only where a message addressed to the bot is (channel,
 * message and server ids, never its words) and starts the machine. Any word from the waking daemon (its announce, its
 * alarm, `sleepHeard`) deletes every token it holds for that sandbox; `sleepHeard` also hands the references over once
 * and forgets them, so the gateway can fetch each message and answer it as if it had just arrived. */

// The connections the platform's watcher speaks. extension-manifest's SLEEP_WATCH_SERVICES is the same list, as a card
// declares it.
export const SleepWatchServiceSchema = z.enum(["discord"]);
// The most a sandbox hands over at one sleep; the platform holds at most as many again per account (api sleep-watch.ts).
export const SLEEP_WATCHES_MAX = 4;
// The most message references the platform keeps per connection while a sandbox sleeps, and hands over at once.
export const SLEEP_HEARD_MAX = 50;
// A card's id in the sandbox (the capabilities store's id).
const ConnectionSchema = z.string().min(1).max(128);
const SnowflakeSchema = z.string().regex(/^\d{1,25}$/u);

// One connection to hold while the machine sleeps: which service, the card it belongs to, and its credential.
export const SleepWatchSchema = z.object({
    service: SleepWatchServiceSchema,
    connection: ConnectionSchema,
    credential: z.string().min(1).max(512),
});
export type SleepWatch = z.infer<typeof SleepWatchSchema>;

// The connections to hold until the sandbox wakes. The list replaces every one held for this sandbox; `[]` drops them.
export const SleepWatchBodySchema = z.object({ watches: z.array(SleepWatchSchema).max(SLEEP_WATCHES_MAX) });
// How many of them the platform holds: fewer than were sent when the account's cap is reached.
export const SleepWatchAnswerSchema = IngressOkSchema.extend({ held: z.number().int().nonnegative() });

// The references to take, for the connections the asking extension's cards hold. Asking ends every hold of the sandbox.
export const SleepHeardBodySchema = z.object({ connections: z.array(ConnectionSchema).max(64) });
// Where one message addressed to the bot is, as the watcher heard it (`at`, ms), never what it says.
export const SleepHeardMessageSchema = z.object({
    service: SleepWatchServiceSchema,
    connection: ConnectionSchema,
    channelId: SnowflakeSchema,
    messageId: SnowflakeSchema,
    guildId: SnowflakeSchema.optional(),
    at: z.number().int().nonnegative(),
});
export type SleepHeardMessage = z.infer<typeof SleepHeardMessageSchema>;
// Oldest first, and forgotten once answered.
export const SleepHeardSchema = z.object({ heard: z.array(SleepHeardMessageSchema).max(64 * SLEEP_HEARD_MAX) });
