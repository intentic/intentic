import { oc } from "@orpc/contract";
import { z } from "zod";
import { PhoneFactsSchema, PhoneScopesSchema } from "../schemas/phone.js";
import { OkSchema } from "../schemas/shared.js";

// What a connected phone can be asked, over the socket its app opened; the phone answers, the daemon asks, inverted
// as every peer door is, since a phone cannot be dialled. Carried as JSON-RPC rather than oRPC frames
// (protocol/phone-protocol.ts says why); each key here is a JSON-RPC method name.
// `mcp` stays one opaque procedure so the app can gain a tool without a matching daemon release.
export const phoneContract = {
    // Refetched on connect and each card read: the person changes the app's access in Android's settings, not here.
    describe: oc.output(PhoneFactsSchema),
    // Pushed on connect and on every card edit; enforced by the app, never checked here. The daemon sends the card's
    // whole config, so its `platform` is accepted and ignored. Not strict, unlike a computer's: the app ships on its own
    // schedule, and it reads a switch it does not know as off rather than refusing the grant and dropping the link.
    setScopes: oc.input(PhoneScopesSchema.extend({ platform: z.string().optional() })).output(OkSchema),
    // Liveness and keepalive; a failure means the phone went away, not that it is merely quiet.
    ping: oc.output(OkSchema),
    // One MCP JSON-RPC message forwarded verbatim in both directions.
    mcp: oc.input(z.unknown()).output(z.unknown()),
};
