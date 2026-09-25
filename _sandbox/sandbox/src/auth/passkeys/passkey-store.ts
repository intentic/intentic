import { createHash, randomBytes, randomInt } from "node:crypto";
import type {
    AuthenticationOptionsJSON,
    AuthenticationResponse,
    PasskeySummary,
    RegistrationOptionsJSON,
    RegistrationResponse,
} from "@intentic/sandbox-contract";
import { utcDayOf } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { defineDocument } from "../../store/documents.js";
import { jsonFile } from "../../store/json-file.js";
import { objectParse } from "../../store/unknown-keys.js";
import { stateRelPath } from "../../state-paths.js";
import { tokenEquals, type VerifiedIdentity } from "../auth.js";
import { rpIdOf } from "../browser-origins.js";
import { ACCEPTED_ALGORITHMS, base64url, verifyAuthentication, verifyRegistration } from "./webauthn.js";

// Passkeys registered with this sandbox, on the daemon's JSON substrate beside members.json: the same trust class,
// since a passkey admits its holder. The file holds public keys, the owner's require-a-passkey switch and the hashes
// of their recovery codes; nothing in it can sign in by itself.

const StoredCredentialSchema = z.object({
    // base64url credential id, the name every assertion carries.
    id: z.string(),
    email: z.string(),
    label: z.string(),
    // The editor host it was registered from; it answers only from there.
    rpId: z.string(),
    publicKey: z.object({ alg: z.union([z.literal(-7), z.literal(-257), z.literal(-8)]), jwk: z.record(z.string(), z.string()) }),
    counter: z.number(),
    transports: z.array(z.string()),
    backedUp: z.boolean(),
    aaguid: z.string(),
    createdAt: z.number(),
    lastUsedAt: z.number().optional(),
    // Display profile captured at registration, for presence when a passkey alone opened the session.
    name: z.string().optional(),
    picture: z.string().optional(),
});
export type StoredCredential = z.infer<typeof StoredCredentialSchema>;

const RecoveryCodeSchema = z.object({ hash: z.string(), usedAt: z.number().optional() });
export type StoredRecoveryCode = z.infer<typeof RecoveryCodeSchema>;

const PasskeysFileSchema = z.object({
    required: z.boolean(),
    credentials: z.array(StoredCredentialSchema),
    recovery: z.array(RecoveryCodeSchema),
});
type PasskeysFile = z.infer<typeof PasskeysFileSchema>;

export const passkeysDocument = defineDocument({ path: stateRelPath(".intentic/identity/passkeys.json"), schema: PasskeysFileSchema });

export interface PasskeyStore {
    readonly list: () => Promise<StoredCredential[]>;
    readonly find: (id: string) => Promise<StoredCredential | undefined>;
    readonly add: (credential: StoredCredential) => Promise<void>;
    readonly remove: (id: string) => Promise<boolean>;
    // Records a sign-in: the counter the authenticator reported, its backup state, and when.
    readonly used: (id: string, counter: number, backedUp: boolean, now: number) => Promise<void>;
    readonly required: () => Promise<boolean>;
    readonly setRequired: (required: boolean) => Promise<void>;
    readonly recovery: () => Promise<readonly StoredRecoveryCode[]>;
    // Replaces the whole set; an empty list is how the policy switching off forgets them.
    readonly setRecovery: (hashes: readonly string[]) => Promise<void>;
    // Marks one code spent; false when no unspent code has that hash.
    readonly spendRecovery: (hash: string, now: number) => Promise<boolean>;
}

export const filePasskeys = (path: string): PasskeyStore => {
    const file = jsonFile<PasskeysFile>(path, {
        parse: objectParse(PasskeysFileSchema),
        fallback: () => ({ required: false, credentials: [], recovery: [] }),
        // The owner's require-a-passkey switch and recovery hashes: a fresh file over an unreadable one would drop both.
        onUnreadable: "refuse",
        document: passkeysDocument,
    });
    return {
        list: async () => [...(await file.read()).credentials],
        find: async (id) => (await file.read()).credentials.find((credential) => credential.id === id),
        add: async (credential) => {
            await file.update((stored) => ({ ...stored, credentials: [...stored.credentials.filter((entry) => entry.id !== credential.id), credential] }));
        },
        remove: async (id) => {
            let removed = false;
            await file.update((stored) => {
                const kept = stored.credentials.filter((credential) => credential.id !== id);
                removed = kept.length !== stored.credentials.length;
                return removed ? { ...stored, credentials: kept } : stored;
            });
            return removed;
        },
        used: async (id, counter, backedUp, now) => {
            await file.update((stored) => ({
                ...stored,
                credentials: stored.credentials.map((credential) => (credential.id === id ? { ...credential, counter, backedUp, lastUsedAt: now } : credential)),
            }));
        },
        required: async () => (await file.read()).required,
        setRequired: async (required) => {
            await file.update((stored) => (stored.required === required ? stored : { ...stored, required }));
        },
        recovery: async () => (await file.read()).recovery,
        setRecovery: async (hashes) => {
            await file.update((stored) => ({ ...stored, recovery: hashes.map((hash) => ({ hash })) }));
        },
        spendRecovery: async (hash, now) => {
            let spent = false;
            await file.update((stored) => {
                const match = stored.recovery.find((code) => code.usedAt === undefined && tokenEquals(code.hash, hash));
                if (match === undefined) {
                    return stored;
                }
                spent = true;
                return { ...stored, recovery: stored.recovery.map((code) => (code === match ? { ...code, usedAt: now } : code)) };
            });
            return spent;
        },
    };
};

// ---- Recovery codes ----

// Lowercase without the four glyphs that read as each other; 20 of these is ~99 bits, so the stored sha256 cannot be
// brute-forced back to a code.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 20;
export const RECOVERY_CODE_COUNT = 8;

// Spelling differences a person introduces copying a code (case, spaces, dashes) are not differences.
export const normalizeRecoveryCode = (input: string): string => input.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

export const hashRecoveryCode = (code: string): string => sha256Hex(normalizeRecoveryCode(code));

// Fresh codes as shown once, and the hashes that are all the daemon keeps.
export const mintRecoveryCodes = (): { readonly codes: readonly string[]; readonly hashes: readonly string[] } => {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
        const raw = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
        return raw.match(/.{5}/g)?.join("-") ?? raw;
    });
    return { codes, hashes: codes.map(hashRecoveryCode) };
};

// ---- Ceremonies ----

// What a ceremony asked for, held between the options call and the response; single-use and short-lived.
interface PendingChallenge {
    readonly kind: "create" | "get";
    // Registration binds the challenge to the person registering; a response from anyone else is refused.
    readonly email?: string;
    readonly origin: string;
    readonly rpId: string;
    readonly expiresAt: number;
}

// Long enough for a phone to be found and a PIN typed; short enough that a leaked options body is inert by lunch.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// The anonymous options route can be hit by anyone; the map never grows past this, the oldest going first.
const MAX_PENDING_CHALLENGES = 2000;
// Wrong recovery codes before the door closes, and for how long. Eight codes of ~99 bits are not guessable; this is
// about a script hammering the route, not about the codes.
const RECOVERY_FAILURE_LIMIT = 10;
const RECOVERY_LOCKOUT_MS = 15 * 60 * 1000;
const CEREMONY_TIMEOUT_MS = 120_000;

// A refusal the routes answer with the given status: 400 a malformed or foreign response, 403 a code that is not one of
// ours, 404 an unknown credential, 409 a step out of order, 429 too many wrong codes.
export class PasskeyError extends Error {
    constructor(
        readonly status: 400 | 403 | 404 | 409 | 429,
        message: string,
    ) {
        super(message);
    }
}

export interface PasskeyCeremonies {
    readonly registrationOptions: (input: { readonly identity: VerifiedIdentity; readonly origin: string | undefined }) => Promise<RegistrationOptionsJSON>;
    readonly register: (input: {
        readonly identity: VerifiedIdentity;
        readonly origin: string | undefined;
        readonly response: RegistrationResponse;
        readonly label: string | undefined;
    }) => Promise<StoredCredential>;
    readonly authenticationOptions: (origin: string | undefined) => Promise<AuthenticationOptionsJSON>;
    // The credential that signed, with its counter already advanced; the caller turns its email into a session.
    readonly authenticate: (input: { readonly origin: string | undefined; readonly response: AuthenticationResponse }) => Promise<StoredCredential>;
    // Spends one of the owner's codes; false for a code that is not one of theirs or was already used.
    readonly spendRecoveryCode: (code: string) => Promise<boolean>;
}

export interface PasskeyCeremonyDeps {
    readonly store: PasskeyStore;
    readonly originAllowed: (origin: string) => boolean;
    // Salts the user handle so two sandboxes never hand one authenticator the same (rpId, handle) pair, which would
    // overwrite one's passkey with the other's.
    readonly sandboxId: string;
    readonly sandboxName: string;
    readonly now?: () => number;
}

export const summaryOf = (credential: StoredCredential): PasskeySummary => ({
    id: credential.id,
    email: credential.email,
    label: credential.label,
    rpId: credential.rpId,
    createdAt: credential.createdAt,
    ...(credential.lastUsedAt !== undefined ? { lastUsedAt: credential.lastUsedAt } : {}),
    backedUp: credential.backedUp,
});

// The label a passkey gets when none was typed: what it is, dated, so two unnamed ones still read apart.
const labelFor = (label: string | undefined, now: number): string => {
    const trimmed = label?.trim().slice(0, 60);
    // The UTC day, not the owner's: a fallback label is a name, not a fact anybody reads a date off, and it is
    // written once and then editable. Precision here would cost a zone the store has no reason to know.
    return trimmed === undefined || trimmed === "" ? `Passkey added ${utcDayOf(now)}` : trimmed;
};

// A verifier's refusal as the 400 the route answers with; the message names what failed to match.
const verified = <T>(run: () => T): T => {
    try {
        return run();
    } catch (error) {
        throw new PasskeyError(400, error instanceof Error ? error.message : "the response did not verify");
    }
};

export const createPasskeyCeremonies = (deps: PasskeyCeremonyDeps): PasskeyCeremonies => {
    const now = deps.now ?? Date.now;
    const pending = new Map<string, PendingChallenge>();
    let recoveryFailures = 0;
    let recoveryLockedUntil = 0;

    const issue = (challenge: Omit<PendingChallenge, "expiresAt">): string => {
        const at = now();
        for (const [key, entry] of pending) {
            if (entry.expiresAt <= at) {
                pending.delete(key);
            }
        }
        while (pending.size >= MAX_PENDING_CHALLENGES) {
            const oldest = pending.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            pending.delete(oldest);
        }
        const id = base64url.encode(randomBytes(32));
        pending.set(id, { ...challenge, expiresAt: at + CHALLENGE_TTL_MS });
        return id;
    };

    // The challenge a response answers, read off its own client data and spent; a response arriving after the TTL, or
    // twice, finds nothing.
    const consume = (clientDataJSON: string, kind: PendingChallenge["kind"]): { readonly challenge: string; readonly issued: PendingChallenge } => {
        let challenge: unknown;
        try {
            challenge = (JSON.parse(base64url.decode(clientDataJSON).toString("utf8")) as { challenge?: unknown }).challenge;
        } catch {
            throw new PasskeyError(400, "client data is not JSON");
        }
        const issued = typeof challenge === "string" ? pending.get(challenge) : undefined;
        if (typeof challenge !== "string" || issued === undefined || issued.kind !== kind) {
            throw new PasskeyError(400, "this response answers no challenge this sandbox issued; start again");
        }
        pending.delete(challenge);
        if (issued.expiresAt <= now()) {
            throw new PasskeyError(400, "the challenge expired; start again");
        }
        return { challenge, issued };
    };

    // The relying party a request is for: its browser origin, which must be one the daemon already trusts for CORS.
    const relyingParty = (origin: string | undefined): { readonly origin: string; readonly rpId: string } => {
        if (origin === undefined || origin === "") {
            throw new PasskeyError(400, "passkeys need a browser origin");
        }
        if (!deps.originAllowed(origin)) {
            throw new PasskeyError(400, `passkeys cannot be bound to ${origin}`);
        }
        return { origin, rpId: rpIdOf(origin) };
    };

    const userHandle = (email: string): string =>
        base64url.encode(createHash("sha256").update(`${deps.sandboxId}:${email.toLowerCase()}`).digest());

    const descriptorsFor = (credentials: readonly StoredCredential[], rpId: string) =>
        credentials.filter((credential) => credential.rpId === rpId).map((credential) => ({ type: "public-key" as const, id: credential.id, transports: credential.transports }));

    return {
        registrationOptions: async ({ identity, origin }) => {
            const rp = relyingParty(origin);
            const own = (await deps.store.list()).filter((credential) => credential.email.toLowerCase() === identity.email.toLowerCase());
            const challenge = issue({ kind: "create", email: identity.email, ...rp });
            return {
                rp: { id: rp.rpId, name: deps.sandboxName === "" ? "intentic" : deps.sandboxName },
                user: {
                    id: userHandle(identity.email),
                    name: identity.email,
                    displayName: deps.sandboxName === "" ? identity.email : `${identity.email} · ${deps.sandboxName}`,
                },
                challenge,
                pubKeyCredParams: ACCEPTED_ALGORITHMS.map((alg) => ({ type: "public-key" as const, alg })),
                timeout: CEREMONY_TIMEOUT_MS,
                attestation: "none",
                // The authenticator refuses to make a second credential for this sandbox rather than duplicating one.
                excludeCredentials: descriptorsFor(own, rp.rpId),
                authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
            };
        },
        register: async ({ identity, origin, response, label }) => {
            const rp = relyingParty(origin);
            const { challenge, issued } = consume(response.response.clientDataJSON, "create");
            if (issued.email === undefined || issued.email.toLowerCase() !== identity.email.toLowerCase() || issued.origin !== rp.origin) {
                throw new PasskeyError(400, "this registration was started by someone else, or from another origin");
            }
            const registration = verified(() => verifyRegistration(response, { challenge, ...rp }));
            if ((await deps.store.find(registration.credentialId)) !== undefined) {
                throw new PasskeyError(409, "this passkey is already registered with the sandbox");
            }
            const at = now();
            const credential: StoredCredential = {
                id: registration.credentialId,
                email: identity.email,
                label: labelFor(label, at),
                rpId: rp.rpId,
                publicKey: registration.publicKey,
                counter: registration.counter,
                transports: [...registration.transports],
                backedUp: registration.backedUp,
                aaguid: registration.aaguid,
                createdAt: at,
                ...(identity.name !== undefined ? { name: identity.name } : {}),
                ...(identity.picture !== undefined ? { picture: identity.picture } : {}),
            };
            await deps.store.add(credential);
            return credential;
        },
        authenticationOptions: async (origin) => {
            const rp = relyingParty(origin);
            const allowCredentials = descriptorsFor(await deps.store.list(), rp.rpId);
            return {
                rpId: rp.rpId,
                challenge: issue({ kind: "get", ...rp }),
                timeout: CEREMONY_TIMEOUT_MS,
                userVerification: "required",
                allowCredentials,
                available: allowCredentials.length > 0,
            };
        },
        authenticate: async ({ origin, response }) => {
            const rp = relyingParty(origin);
            const { challenge, issued } = consume(response.response.clientDataJSON, "get");
            if (issued.origin !== rp.origin) {
                throw new PasskeyError(400, "this sign-in was started from another origin");
            }
            const credential = await deps.store.find(response.id);
            if (credential === undefined || credential.rpId !== rp.rpId) {
                throw new PasskeyError(404, "no passkey registered with this sandbox answers that id");
            }
            const assertion = verified(() => verifyAuthentication(response, { challenge, ...rp, publicKey: credential.publicKey, counter: credential.counter }));
            const at = now();
            await deps.store.used(credential.id, assertion.counter, assertion.backedUp, at);
            return { ...credential, counter: assertion.counter, backedUp: assertion.backedUp, lastUsedAt: at };
        },
        spendRecoveryCode: async (code) => {
            const at = now();
            if (at < recoveryLockedUntil) {
                throw new PasskeyError(429, `too many wrong recovery codes; try again in ${Math.ceil((recoveryLockedUntil - at) / 60_000)} minutes`);
            }
            const spent = await deps.store.spendRecovery(hashRecoveryCode(code), at);
            if (spent) {
                recoveryFailures = 0;
                return true;
            }
            recoveryFailures += 1;
            if (recoveryFailures >= RECOVERY_FAILURE_LIMIT) {
                recoveryFailures = 0;
                recoveryLockedUntil = at + RECOVERY_LOCKOUT_MS;
            }
            return false;
        },
    };
};
