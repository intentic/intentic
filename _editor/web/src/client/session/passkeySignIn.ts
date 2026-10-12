import {
    type AuthenticationOptionsJSON,
    type AuthenticationResponse,
    type DaemonSession,
    type PasskeyRegistered,
    RAW_JSON_ROUTES,
    type RawJsonInput,
    type RawJsonOutput,
    type RawJsonRouteKey,
    rawRoutePath,
    type RegistrationOptionsJSON,
    type RegistrationResponse,
    type SessionRecovered,
} from "@intentic/sandbox-contract";
import type { z } from "zod";
import type { SandboxTarget } from "../sandbox/sandboxTarget";
import { t } from "@intentic/ui/i18n";

// The browser half of a passkey ceremony against the sandbox daemon, which is the relying party. Raw fetches on
// purpose: these calls are how a session is minted (or upgraded), so they cannot ride the client that would try to
// sign in before sending them. Each is still a route of the contract's table (`RAW_JSON_ROUTES`), so its path comes from
// the key and its answer is read with the route's own schema, as `sandboxRaw` does for a call with a session. Every
// binary field crosses as base64url, the form the daemon parses.

export class PasskeyRefusedError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

export const browserSupportsPasskeys = (): boolean => typeof window !== `undefined` && typeof window.PublicKeyCredential === `function`;

// Over a fresh ArrayBuffer, never a shared one: the WebAuthn API's BufferSource refuses the shared kind.
const toBytes = (base64url: string): Uint8Array<ArrayBuffer> => {
    const padded = base64url.replaceAll(`-`, `+`).replaceAll(`_`, `/`).padEnd(Math.ceil(base64url.length / 4) * 4, `=`);
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};

const toBase64Url = (buffer: ArrayBuffer): string =>
    btoa(String.fromCodePoint(...new Uint8Array(buffer)))
        .replaceAll(`+`, `-`)
        .replaceAll(`/`, `_`)
        .replace(/=+$/, ``);

const descriptors = (entries: readonly { readonly type: `public-key`; readonly id: string; readonly transports?: readonly string[] }[]) =>
    entries.map((entry) => ({
        type: entry.type,
        id: toBytes(entry.id),
        ...(entry.transports === undefined ? {} : { transports: [...entry.transports] as AuthenticatorTransport[] }),
    }));

// The daemon's answer, or its refusal as an error carrying the status the daemon chose.
const answer = async <Schema extends z.ZodType>(response: Response, schema: Schema): Promise<z.output<Schema>> => {
    if (response.ok) {
        return schema.parse(await response.json());
    }
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
    throw new PasskeyRefusedError(response.status, typeof body?.error === `string` ? body.error : t(`sandbox.passkeySignIn.refused`, { status: response.status }));
};

const post = (target: SandboxTarget, path: string, body: unknown, bearer?: string): Promise<Response> =>
    fetch(`${target.base}${path}`, {
        method: `POST`,
        headers: {
            "content-type": `application/json`,
            ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
            ...(target.connectToken === undefined ? {} : { "x-intentic-connect": target.connectToken }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
    });

// One of the table's routes, sent as `target` presents itself (a connect token, and a bearer where the caller has one
// that is not a session yet), its answer read with the route's own schema.
const ask = async <Key extends RawJsonRouteKey>(
    key: Key,
    target: SandboxTarget,
    body: RawJsonInput<Key> | undefined,
    bearer?: string,
): Promise<RawJsonOutput<Key>> =>
    // SAFETY: the route's own output schema parsed the answer, and RawJsonOutput is that schema's output for this key.
    (await answer(await post(target, rawRoutePath(key), body ?? {}, bearer), RAW_JSON_ROUTES[key].output)) as RawJsonOutput<Key>;

// Runs the browser's `get()` for the daemon's options; the person picks a passkey and the authenticator checks them.
export const assertPasskey = async (options: AuthenticationOptionsJSON): Promise<AuthenticationResponse> => {
    const credential = await navigator.credentials.get({
        publicKey: {
            rpId: options.rpId,
            challenge: toBytes(options.challenge),
            timeout: options.timeout,
            userVerification: options.userVerification,
            allowCredentials: descriptors(options.allowCredentials),
        },
    });
    if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
        throw new Error(t(`sandbox.passkeySignIn.noneUsed`));
    }
    const response = credential.response;
    return {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: `public-key`,
        response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            authenticatorData: toBase64Url(response.authenticatorData),
            signature: toBase64Url(response.signature),
            ...(response.userHandle === null ? {} : { userHandle: toBase64Url(response.userHandle) }),
        },
    };
};

// Runs the browser's `create()` for the daemon's options; the authenticator makes a key it will only ever use here.
export const createPasskey = async (options: RegistrationOptionsJSON): Promise<RegistrationResponse> => {
    const credential = await navigator.credentials.create({
        publicKey: {
            rp: options.rp,
            user: { id: toBytes(options.user.id), name: options.user.name, displayName: options.user.displayName },
            challenge: toBytes(options.challenge),
            pubKeyCredParams: [...options.pubKeyCredParams],
            timeout: options.timeout,
            attestation: options.attestation,
            excludeCredentials: descriptors(options.excludeCredentials),
            authenticatorSelection: { ...options.authenticatorSelection },
        },
    });
    if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
        throw new Error(t(`sandbox.passkeySignIn.noneCreated`));
    }
    const response = credential.response;
    return {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: `public-key`,
        response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            attestationObject: toBase64Url(response.attestationObject),
            transports: response.getTransports(),
        },
    };
};

// Whether a passkey registered with this sandbox can answer from this origin; undefined when the daemon predates the
// route or this browser has no WebAuthn, both meaning the button has nothing to do.
export const passkeyOffered = async (target: SandboxTarget): Promise<boolean> => {
    if (!browserSupportsPasskeys()) {
        return false;
    }
    try {
        return (await ask(`POST /system/passkeys/assert/options`, target, undefined)).available;
    } catch {
        return false;
    }
};

// The whole sign-in: fresh options (a challenge lives five minutes, so none is fetched ahead of the press), the
// ceremony, the assertion exchanged for a session.
export const signInWithPasskey = async (target: SandboxTarget): Promise<DaemonSession> => {
    const options = await ask(`POST /system/passkeys/assert/options`, target, undefined);
    if (!options.available) {
        throw new Error(t(`sandbox.passkeySignIn.noneRegistered`, { host: window.location.host }));
    }
    const response = await assertPasskey(options);
    return ask(`POST /system/passkeys/assert`, target, { response });
};

// Registers a passkey under `bearer` (a session, or the Google proof of someone enrolling their first under the
// require-passkey policy) and names it `label`.
export const registerPasskey = async (target: SandboxTarget, bearer: string, label: string | undefined): Promise<PasskeyRegistered> => {
    const options = await ask(`POST /system/passkeys/register/options`, target, undefined, bearer);
    const response = await createPasskey(options);
    return ask(`POST /system/passkeys/register`, target, label === undefined ? { response } : { response, label }, bearer);
};

// The owner's way back in without a passkey: their Google proof plus one of the codes shown when the policy went on.
export const recoverWithCode = async (target: SandboxTarget, bearer: string, code: string): Promise<SessionRecovered> =>
    ask(`POST /system/session/recover`, target, { code }, bearer);
