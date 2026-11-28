import { S2S_ENVELOPE_MAX_BYTES, S2S_SESSION_HEADER, S2sCallSealedSchema, S2sSessionOpenSchema } from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import type { CallDoor } from "./call-door.js";

// THE CALLS DOORS (docs/architecture/messages.md, "Calls"): `POST /s2s/session` and `POST /s2s/call/{method}`, each
// checking its own credential (`auth: "door"`): a session request's signature, a call's session key. Everything past the
// parse is the door's (call-door.ts). Neither ever answers 401, which a caller reads as a daemon too old for the door.

// A session request is a few kilobytes; a call carries at most a sealed body's cap.
const SESSION_MAX_BYTES = 64 * 1024;

/** The calls doors over a calls door, as the daemon and a suite's two daemons serve them alike. */
export const callsRoutesOf = (door: CallDoor) => ({
    "POST /s2s/session": async (c: Context<AppEnv>) => {
        const read = await readBoundedJson(c.req.raw, SESSION_MAX_BYTES);
        const request = read.kind === "ok" ? S2sSessionOpenSchema.safeParse(read.value) : undefined;
        if (request?.success !== true) {
            return c.json({ error: "not a session request (S2sSessionOpenSchema)", code: "malformed" }, 400);
        }
        const answer = await door.open(request.data);
        return c.json(answer.body, answer.status);
    },
    "POST /s2s/call/{method}": async (c: Context<AppEnv>) => {
        const read = await readBoundedJson(c.req.raw, S2S_ENVELOPE_MAX_BYTES);
        if (read.kind === "tooLarge") {
            return c.json({ error: `a call is at most ${S2S_ENVELOPE_MAX_BYTES} bytes`, code: "too_large" }, 413);
        }
        const sealed = read.kind === "ok" ? S2sCallSealedSchema.safeParse(read.value) : undefined;
        if (sealed?.success !== true) {
            return c.json({ error: "not a sealed call (S2sCallSealedSchema)", code: "malformed" }, 400);
        }
        const answer = await door.call(c.req.header(S2S_SESSION_HEADER) ?? "", c.req.param("method") ?? "", sealed.data, c.req.raw.signal);
        return c.json(answer.body, answer.status);
    },
});

export const s2sCallsRawRoutes = defineRawRoutes((services: Pick<Services, "s2s">) => callsRoutesOf(services.s2s.calls.door));
