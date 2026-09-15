import {
    PasskeyAssertRequestSchema,
    PasskeyPolicySchema,
    PasskeyRecoverRequestSchema,
    PasskeyRegisterRequestSchema,
    type PasskeysList,
} from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { bearerFrom, ForbiddenError, type Proof } from "../auth.js";
import { ownershipDenied } from "../owner-gates.js";
import { mintRecoveryCodes, PasskeyError, type StoredCredential, summaryOf } from "./passkey-store.js";

// The sandbox as WebAuthn relying party: each member's own passkeys, the two anonymous doors a passkey signs in
// through, the owner's require-a-passkey switch, and the recovery codes that keep that switch from locking the owner
// out. Plain routes before the oRPC catch-all, like the roster beside them.

export type PasskeyRoutesDeps = Pick<Services, "auth" | "passkeys" | "passkeyCeremonies" | "ownerEmail" | "wsTickets">;

const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

// A ceremony's refusal answers with its own status; anything else is the daemon's fault and propagates as a 500.
const refused = (c: Context, error: unknown): Response => {
    if (error instanceof PasskeyError) {
        return c.json({ error: error.message }, error.status);
    }
    throw error;
};

// The request body through its schema, or undefined for anything that is not the expected shape.
const bodyOf = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | undefined> =>
    schema.safeParse(await c.req.json().catch(() => undefined)).data;

// A bearer refusal on the doors that check their own: 403 for a verified stranger, 401 for everything else.
const denied = (c: Context, error: unknown): Response =>
    error instanceof ForbiddenError ? c.json({ error: error.message }, 403) : c.json({ error: "unauthorized" }, 401);

const sessionOf = (minted: { readonly token: string; readonly expiresAt: number }, email: string) => ({ token: minted.token, expiresAt: minted.expiresAt, email });

export const createPasskeyRoutes = (services: PasskeyRoutesDeps) => {
    // Whether removing `credential` would leave the owner with none while the policy still demands one.
    const ownersLast = async (credential: StoredCredential): Promise<boolean> => {
        const owner = await services.ownerEmail();
        if (owner === undefined || !sameEmail(credential.email, owner) || !(await services.passkeys.required())) {
            return false;
        }
        return (await services.passkeys.list()).filter((entry) => sameEmail(entry.email, owner)).length <= 1;
    };
    const unspentRecovery = async (): Promise<number> => (await services.passkeys.recovery()).filter((code) => code.usedAt === undefined).length;

    return {
        /** GET /system/passkeys */
        list: async (c: Context<AppEnv>): Promise<Response> => {
            const identity = c.get("identity");
            if (services.auth === undefined || identity === undefined) {
                return c.json({ error: "no verified identity to list passkeys for" }, 404);
            }
            const all = await services.passkeys.list();
            // The owner sees everyone's, since resetting a locked-out member is theirs to do; a member sees only their own.
            const visible = identity.role === "owner" ? all : all.filter((credential) => sameEmail(credential.email, identity.email));
            const required = await services.passkeys.required();
            const list: PasskeysList = {
                passkeys: visible.map(summaryOf),
                required,
                ...(identity.role === "owner" && required ? { recovery: { remaining: await unspentRecovery() } } : {}),
            };
            return c.json(list);
        },
        /** POST /system/passkeys/register/options */
        registerOptions: async (c: Context<AppEnv>): Promise<Response> => {
            const identity = c.get("identity");
            if (services.auth === undefined || identity === undefined) {
                return c.json({ error: "no verified identity to register a passkey for" }, 404);
            }
            try {
                return c.json(await services.passkeyCeremonies.registrationOptions({ identity, origin: c.req.header("origin") }));
            } catch (error) {
                return refused(c, error);
            }
        },
        /** POST /system/passkeys/register */
        register: async (c: Context<AppEnv>): Promise<Response> => {
            const identity = c.get("identity");
            if (services.auth === undefined || identity === undefined) {
                return c.json({ error: "no verified identity to register a passkey for" }, 404);
            }
            const request = await bodyOf(c, PasskeyRegisterRequestSchema);
            if (request === undefined) {
                return c.json({ error: "a WebAuthn registration response is required" }, 400);
            }
            let credential: StoredCredential;
            try {
                credential = await services.passkeyCeremonies.register({ identity, origin: c.req.header("origin"), response: request.response, label: request.label });
            } catch (error) {
                return refused(c, error);
            }
            if (identity.methods.includes("passkey")) {
                return c.json({ passkey: summaryOf(credential) });
            }
            // The ceremony just proved possession under user verification: the session that asked is upgraded on the
            // spot, so the browser holds a passkey-proven credential without a second ceremony.
            const proof: Proof = { ...identity, methods: [...identity.methods, "passkey"], credentialId: credential.id };
            return c.json({ passkey: summaryOf(credential), session: sessionOf(await services.auth.mintSession(proof), identity.email) });
        },
        /** DELETE /system/passkeys/:id */
        remove: async (c: Context<AppEnv, "/system/passkeys/:id">): Promise<Response> => {
            const identity = c.get("identity");
            if (services.auth === undefined || identity === undefined) {
                return c.json({ error: "no verified identity" }, 404);
            }
            const credential = await services.passkeys.find(c.req.param("id"));
            if (credential === undefined) {
                return c.json({ error: "no such passkey" }, 404);
            }
            if (!sameEmail(credential.email, identity.email) && identity.role !== "owner") {
                return c.json({ error: "only the owner may remove another member's passkey" }, 403);
            }
            if (await ownersLast(credential)) {
                return c.json({ error: "this is your last passkey; stop requiring a passkey before removing it" }, 409);
            }
            await services.passkeys.remove(credential.id);
            // Sessions from this passkey are refused per request from here on; the transports already open under them
            // are closed so a lost device's live streams end now, not at their next request.
            services.auth.connections.revoke(credential.email);
            services.wsTickets.revoke(credential.email);
            return c.json({ ok: true });
        },
        /** POST /system/passkeys/assert/options, anonymous */
        assertOptions: async (c: Context<AppEnv>): Promise<Response> => {
            if (services.auth === undefined) {
                return c.json({ error: "this daemon has no sign-in" }, 404);
            }
            try {
                return c.json(await services.passkeyCeremonies.authenticationOptions(c.req.header("origin")));
            } catch (error) {
                return refused(c, error);
            }
        },
        /** POST /system/passkeys/assert, anonymous: a passkey assertion becomes a session */
        assert: async (c: Context<AppEnv>): Promise<Response> => {
            if (services.auth === undefined) {
                return c.json({ error: "this daemon has no sign-in" }, 404);
            }
            const request = await bodyOf(c, PasskeyAssertRequestSchema);
            if (request === undefined) {
                return c.json({ error: "a WebAuthn authentication response is required" }, 400);
            }
            let credential: StoredCredential;
            try {
                credential = await services.passkeyCeremonies.authenticate({ origin: c.req.header("origin"), response: request.response });
            } catch (error) {
                return refused(c, error);
            }
            const proof: Proof = {
                email: credential.email,
                ...(credential.name !== undefined ? { name: credential.name } : {}),
                ...(credential.picture !== undefined ? { picture: credential.picture } : {}),
                methods: ["passkey"],
                credentialId: credential.id,
            };
            try {
                const caller = await services.auth.authorizeProven(proof);
                return c.json(sessionOf(await services.auth.mintSession(caller), caller.email));
            } catch (error) {
                return denied(c, error);
            }
        },
        /** POST /system/session/recover: the owner's Google proof plus one recovery code becomes a session */
        recover: async (c: Context<AppEnv>): Promise<Response> => {
            if (services.auth === undefined) {
                return c.json({ error: "this daemon has no sign-in" }, 404);
            }
            const request = await bodyOf(c, PasskeyRecoverRequestSchema);
            if (request === undefined) {
                return c.json({ error: "a recovery code is required" }, 400);
            }
            try {
                const caller = await services.auth.authorizeRecovery(bearerFrom(c.req.header("authorization")));
                if (!(await services.passkeyCeremonies.spendRecoveryCode(request.code))) {
                    return c.json({ error: "that recovery code is not one of yours, or was already used" }, 403);
                }
                const proof: Proof = { ...caller, methods: [...caller.methods, "recovery"] };
                return c.json({ ...sessionOf(await services.auth.mintSession(proof), caller.email), remaining: await unspentRecovery() });
            } catch (error) {
                if (error instanceof PasskeyError) {
                    return refused(c, error);
                }
                return denied(c, error);
            }
        },
        /** POST /system/passkeys/policy, owner */
        setPolicy: async (c: Context<AppEnv>): Promise<Response> => {
            const gate = await ownershipDenied(services, c);
            if (gate !== undefined) {
                return gate;
            }
            const request = await bodyOf(c, PasskeyPolicySchema);
            if (request === undefined) {
                return c.json({ error: "required must be true or false" }, 400);
            }
            if (!request.required) {
                await services.passkeys.setRequired(false);
                await services.passkeys.setRecovery([]);
                return c.json({ required: false });
            }
            // The one guard against locking the owner out on the spot: the switch needs something to open the door.
            const owner = await services.ownerEmail();
            if (owner === undefined || !(await services.passkeys.list()).some((credential) => sameEmail(credential.email, owner))) {
                return c.json({ error: "add a passkey of your own before requiring one" }, 409);
            }
            const { codes, hashes } = mintRecoveryCodes();
            await services.passkeys.setRequired(true);
            await services.passkeys.setRecovery(hashes);
            // Streams opened under a proof with no passkey would otherwise run on; closing them makes every browser
            // re-enter the authorizer, where the policy now asks.
            services.auth?.connections.revoke();
            services.wsTickets.revoke();
            return c.json({ required: true, codes });
        },
        /** POST /system/passkeys/recovery, owner: a fresh set of codes, the old ones forgotten */
        regenerateRecovery: async (c: Context<AppEnv>): Promise<Response> => {
            const gate = await ownershipDenied(services, c);
            if (gate !== undefined) {
                return gate;
            }
            if (!(await services.passkeys.required())) {
                return c.json({ error: "recovery codes exist only while a passkey is required" }, 409);
            }
            const { codes, hashes } = mintRecoveryCodes();
            await services.passkeys.setRecovery(hashes);
            return c.json({ codes });
        },
    };
};
