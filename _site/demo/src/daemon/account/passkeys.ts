import type {
    AuthenticationOptionsJSON,
    DaemonSession,
    PasskeyPolicyAnswer,
    PasskeyRegistered,
    PasskeySummary,
    PasskeysList,
    RecoveryCodes,
    RegistrationOptionsJSON,
    SessionRecovered,
} from "@intentic/sandbox-contract/schemas/system";
import type { RawJsonOutput } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import { refuse } from "@intentic/contract-serve";
import { DEMO_USER } from "../../platform";

// Passkeys on this sandbox (the daemon's auth/passkeys/): the owner's list, the rule that a passkey is the only way in
// with its one-time recovery codes, and both WebAuthn ceremonies. The daemon is the relying party, so its half is all
// here: the options handed to the browser name this page's own host, so a real authenticator can answer them, and a
// response is accepted as the daemon accepts a verified one. Proving it cryptographically is the one part left out:
// the demo's session is seeded, so there is nothing for a signature to protect.

const DAY = 24 * 3_600_000;
const SESSION_MS = 30 * DAY;
const CEREMONY_MS = 120_000;
const RECOVERY_CODES = 10;

const passkeys: PasskeySummary[] = [
    {
        id: `pk_demo_macbook`,
        email: DEMO_USER.email,
        label: `MacBook Air`,
        rpId: `app.intentic.dev`,
        createdAt: Date.now() - 41 * DAY,
        lastUsedAt: Date.now() - 2 * 3_600_000,
        backedUp: true,
    },
];

// The require rule and the recovery codes still unspent while it is on; the codes themselves are shown once, here.
interface Policy {
    required: boolean;
    codes: string[];
}
const policy: Policy = { required: false, codes: [] };

export const passkeysList = (): PasskeysList => ({
    passkeys: passkeys.map((passkey) => ({ ...passkey })),
    required: policy.required,
    recovery: policy.required ? { remaining: policy.codes.length } : undefined,
});

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll(`+`, `-`).replaceAll(`/`, `_`).replace(/=+$/, ``);
const challenge = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));
// The relying party a passkey made here is bound to: this page's own host, so the browser's ceremony can succeed.
const rpId = (): string => (`location` in globalThis ? globalThis.location.hostname : `app.intentic.dev`);

const session = (): DaemonSession => ({ token: `demo-session`, expiresAt: Date.now() + SESSION_MS, email: DEMO_USER.email });

export const registrationOptions = (): RegistrationOptionsJSON => ({
    rp: { id: rpId(), name: `acme-shop` },
    user: { id: base64url(new TextEncoder().encode(DEMO_USER.email)), name: DEMO_USER.email, displayName: DEMO_USER.name },
    challenge: challenge(),
    pubKeyCredParams: [
        { type: `public-key`, alg: -7 },
        { type: `public-key`, alg: -257 },
    ],
    timeout: CEREMONY_MS,
    attestation: `none`,
    excludeCredentials: passkeys.map((passkey) => ({ type: `public-key`, id: passkey.id })),
    authenticatorSelection: { residentKey: `required`, requireResidentKey: true, userVerification: `required` },
});

// The authenticator's own name for itself is not in its response; a platform one syncs, which is how most are made.
export const registerPasskey = (id: string, label: string | undefined, attachment: string | undefined): PasskeyRegistered => {
    if (passkeys.some((passkey) => passkey.id === id)) {
        return refuse(`that passkey is already registered here`, 409);
    }
    const passkey: PasskeySummary = {
        id,
        email: DEMO_USER.email,
        label: label ?? (attachment === `cross-platform` ? `Security key` : `Passkey`),
        rpId: rpId(),
        createdAt: Date.now(),
        backedUp: attachment !== `cross-platform`,
    };
    passkeys.push(passkey);
    return { passkey, session: session() };
};

export const removePasskey = (id: string): RawJsonOutput<`DELETE /system/passkeys/{id}`> => {
    const at = passkeys.findIndex((passkey) => passkey.id === id);
    if (at === -1) {
        return refuse(`no passkey by that id`, 404);
    }
    if (policy.required && passkeys.length === 1) {
        return refuse(`this is the last passkey and a passkey is required to open this sandbox; turn that rule off first`, 409);
    }
    passkeys.splice(at, 1);
    return { ok: true };
};

// Ten codes in two groups of five, the shape a person copies down; each opens the sandbox once.
const mintCodes = (): string[] =>
    Array.from({ length: RECOVERY_CODES }, () => {
        const digits = base64url(crypto.getRandomValues(new Uint8Array(8))).replace(/[-_]/g, `x`).slice(0, 10).toLowerCase();
        return `${digits.slice(0, 5)}-${digits.slice(5)}`;
    });

/** Switching the rule on needs a passkey to answer it, and hands out the recovery codes; off forgets them. */
export const setPasskeyPolicy = (required: boolean): PasskeyPolicyAnswer => {
    if (required && passkeys.length === 0) {
        return refuse(`add a passkey before requiring one, or nobody could open this sandbox`, 409);
    }
    policy.required = required;
    policy.codes = required ? mintCodes() : [];
    return required ? { required, codes: [...policy.codes] } : { required };
};

export const renewRecoveryCodes = (): RecoveryCodes => {
    if (!policy.required) {
        return refuse(`recovery codes exist only while a passkey is required`, 409);
    }
    policy.codes = mintCodes();
    return { codes: [...policy.codes] };
};

export const assertionOptions = (): AuthenticationOptionsJSON => ({
    rpId: rpId(),
    challenge: challenge(),
    timeout: CEREMONY_MS,
    userVerification: `required`,
    allowCredentials: [],
    available: passkeys.some((passkey) => passkey.rpId === rpId()),
});

/** A sign-in answered by a passkey registered here; one this sandbox does not know is refused, as the daemon does. */
export const assertPasskey = (id: string): DaemonSession => {
    const passkey = passkeys.find((candidate) => candidate.id === id) ?? refuse(`this sandbox does not know that passkey`, 401);
    passkey.lastUsedAt = Date.now();
    return session();
};

/** The owner's way back in with a recovery code; each opens it once. */
export const recoverSession = (code: string): SessionRecovered => {
    const at = policy.codes.indexOf(code.trim().toLowerCase());
    if (at === -1) {
        return refuse(`that recovery code is not one of this sandbox's, or it was already used`, 401);
    }
    policy.codes.splice(at, 1);
    return { ...session(), remaining: policy.codes.length };
};
