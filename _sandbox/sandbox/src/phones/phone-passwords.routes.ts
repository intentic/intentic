import {
    PHONE_PASSWORDS_PATHS,
    type PhoneKeyring,
    PhonePasswordsCaptureSchema,
    PhonePasswordsFillSchema,
    PhonePasswordsPairSchema,
} from "@intentic/sandbox-contract/schemas/phone-passwords";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import { opt } from "../opt.js";
import { bearerPeer } from "../peers/peer-store.js";
import type { KeyringLink } from "../secrets/device/keyring-link.js";
import type { PhonePairings } from "./phone-pairings.js";

// THE PHONE'S WAY TO THE OWNER'S PASSWORDS (schemas/phone-passwords.ts): the Intentic Device app, as Android's autofill
// service, lists the owner's keyrings, pairs with one, saves what the person signed in with and fills it back. Each is a
// plain HTTPS request on the phone's enrollment token, the one its socket presents (peers/peer-store.ts bearerPeer), and
// each is relayed to the named computer's keyring over that computer's device link. What rides is sealed end to end, so
// the sandbox carries ciphertext both ways; a keyring's refusal is the answer's body, never an HTTP error, so the app
// reads the keyring's own words.

export interface PhonePasswordsDeps {
    readonly phones: Pick<Services["phones"], "verify">;
    readonly link: Pick<KeyringLink, "computers" | "passwords">;
    readonly pairings: PhonePairings;
    readonly now?: () => number;
}

// A phone asks once to list and once per save or fill; anything faster is a loop, and a fill asks a person each time.
const LIMITS = { any: 30, fill: 10 } as const;
const WINDOW_MS = 60_000;

// A per-phone token bucket, refilled continuously: `limit` requests a minute, a burst of that many.
const bucketsOf = (now: () => number) => {
    const buckets = new Map<string, { tokens: number; at: number }>();
    return (key: string, limit: number): boolean => {
        const at = now();
        const bucket = buckets.get(key) ?? { tokens: limit, at };
        const tokens = Math.min(limit, bucket.tokens + ((at - bucket.at) * limit) / WINDOW_MS);
        if (tokens < 1) {
            buckets.set(key, { tokens, at });
            return false;
        }
        buckets.set(key, { tokens: tokens - 1, at });
        return true;
    };
};

type Handler = (c: Context<AppEnv>) => Promise<Response>;

export const createPhonePasswordsRoutes = (deps: PhonePasswordsDeps) => {
    const now = deps.now ?? Date.now;
    const take = bucketsOf(now);
    // The phone presenting a live enrollment token, inside its rate; or the answer that turns it away.
    const caller = async (c: Context<AppEnv>, kind: keyof typeof LIMITS): Promise<{ readonly phone: string } | Response> => {
        const phone = await bearerPeer(deps.phones, c);
        if (phone instanceof Response) {
            return phone;
        }
        const allowed = take(`${phone}:any`, LIMITS.any) && (kind === "any" || take(`${phone}:${kind}`, LIMITS[kind]));
        return allowed ? { phone } : c.json({ error: "too many requests from this phone; try again in a minute" }, 429);
    };
    // A POST from an enrolled phone, its body read by the contract's schema before anything is relayed.
    const posted =
        <S extends z.ZodType>(kind: keyof typeof LIMITS, schema: S, handle: (phone: string, input: z.output<S>, c: Context<AppEnv>) => Promise<Response>): Handler =>
        async (c) => {
            const who = await caller(c, kind);
            if (who instanceof Response) {
                return who;
            }
            // allow(silent-catch): a body that is not JSON is answered as the 400 just below
            const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
            if (!parsed.success) {
                return c.json({ error: `invalid request: ${parsed.error.issues[0]?.message ?? "unreadable body"}` }, 400);
            }
            return handle(who.phone, parsed.data, c);
        };
    const keyrings: Handler = async (c) => {
        const who = await caller(c, "any");
        if (who instanceof Response) {
            return who;
        }
        const [computers, paired] = await Promise.all([deps.link.computers(), deps.pairings.of(who.phone)]);
        const listed = computers.map(
            (computer): PhoneKeyring => ({
                device: computer.machine,
                // A connection of a card (`rog::wsl:archlinux`) reads as its computer, which is what the person named.
                label: parseHostConnection(computer.machine).card,
                online: computer.online,
                ...opt("locked", computer.locked),
                ...opt("inbox", computer.inbox),
                remember: computer.remember?.phone ?? false,
                paired: paired.has(computer.machine),
            }),
        );
        return c.json({ keyrings: listed });
    };
    return {
        [`GET ${PHONE_PASSWORDS_PATHS.keyrings}` as const]: keyrings,
        [`POST ${PHONE_PASSWORDS_PATHS.pair}` as const]: posted("any", PhonePasswordsPairSchema, async (phone, input, c) => {
            const answer = await deps.link.passwords.phonePair(input.keyring, input.phone, c.req.raw.signal);
            if (answer.ok) {
                await deps.pairings.add({ phone, keyring: input.keyring, fingerprint: answer.fingerprint, at: now() });
            }
            return c.json(answer);
        }),
        [`POST ${PHONE_PASSWORDS_PATHS.capture}` as const]: posted("any", PhonePasswordsCaptureSchema, async (_phone, input, c) => {
            // The phone's door carries the phone's captures only: a source it could not have seen is not its to send.
            if (input.item.source !== "phone") {
                return c.json({ error: "a phone sends captures of source `phone` only" }, 400);
            }
            return c.json(await deps.link.passwords.capture(input.keyring, input.item));
        }),
        [`POST ${PHONE_PASSWORDS_PATHS.fill}` as const]: posted("fill", PhonePasswordsFillSchema, async (_phone, input, c) =>
            c.json(await deps.link.passwords.phoneFill(input.keyring, input.fill, c.req.raw.signal)),
        ),
    } satisfies Record<string, Handler>;
};
