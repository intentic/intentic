import { z } from "zod";

// The phone door's wire, /system/phones/connect. The first frame is the same hello every peer sends. After it, unlike
// the machine and browser doors, the socket carries plain JSON-RPC 2.0 rather than oRPC's own framing: the far end is
// a Kotlin app, and JSON-RPC is a format it can implement from its one-page spec, where oRPC's is an internal of a
// TypeScript library. The daemon still drives it through the same typed client every door has (phones/json-rpc-link.ts
// on the daemon side), so only the bytes differ. fixtures/phone-wire.json holds example exchanges both sides test
// against.
//
// The daemon sends requests, the phone only answers:
//   → {"jsonrpc":"2.0","id":7,"method":"describe"}
//   ← {"jsonrpc":"2.0","id":7,"result":{...PhoneFacts}}
// `method` is a procedure of phoneContract; `params` is its input, absent when it takes none. A failure is an `error`
// with a code and a message the agent may read.

/* HOW OFTEN THIS DOOR PINGS A CONNECTED PHONE, read by both sides of the socket. Longer than a computer's: every ping
wakes the phone's radio, and the phone holds the socket only while it is working or set to stay connected. Carrier NATs
drop an idle connection after a few minutes, so the ping still has to come well inside that. The app declares the link
dead after three missed pings, as every peer does. */
export const PHONE_HEARTBEAT_MS = 60_000;

/* How long a call to a sleeping phone waits for it to wake and dial in, after the sandbox pushed it awake. Long enough
for a push to arrive and a phone on mobile data to connect, short enough that a phone that will not come answers the
agent with "asleep" while the turn can still do something else. */
export const PHONE_WAKE_WAIT_MS = 20_000;

/* How long an awake phone keeps its socket after its last call, unless the person set it to stay connected. Read by
the app; the sandbox only learns of it as a socket that closed normally. */
export const PHONE_LINGER_MS = 5 * 60_000;

export const PhoneHelloSchema = z.object({
    type: z.literal("hello"),
    // Enrollment token, in the first frame and never the URL.
    token: z.string(),
    // The app's build, so an outdated one is visible rather than mysteriously missing a tool.
    version: z.string(),
});
export type PhoneHello = z.infer<typeof PhoneHelloSchema>;

// The procedures the daemon calls; each is a key of phoneContract.
export const PHONE_METHODS = ["describe", "setScopes", "ping", "mcp"] as const;
export type PhoneMethod = (typeof PHONE_METHODS)[number];

export const PhoneRequestSchema = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.number().int().nonnegative(),
    method: z.enum(PHONE_METHODS),
    params: z.unknown().optional(),
});
export type PhoneRequest = z.infer<typeof PhoneRequestSchema>;

// JSON-RPC's own codes, plus the two the phone answers with for a refusal the agent should read as a refusal.
export const PHONE_ERROR = {
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
    // The person paused the app, or a switch is off.
    refused: -32001,
} as const;

export const PhoneResponseSchema = z.union([
    z.object({ jsonrpc: z.literal("2.0"), id: z.number().int().nonnegative(), result: z.unknown() }),
    z.object({
        jsonrpc: z.literal("2.0"),
        id: z.number().int().nonnegative().nullable(),
        error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }),
    }),
]);
export type PhoneResponse = z.infer<typeof PhoneResponseSchema>;
