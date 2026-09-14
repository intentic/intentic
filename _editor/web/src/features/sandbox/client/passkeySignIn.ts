import type {
    AuthenticationOptionsJSON,
    AuthenticationResponse,
    DaemonSession,
    PasskeySummary,
    RegistrationOptionsJSON,
    RegistrationResponse,
} from "@intentic/sandbox-contract";
import type { SandboxTarget } from "./sandboxTarget";

// The browser half of a passkey ceremony against the sandbox daemon, which is the relying party. Raw fetches on
// purpose: these calls are how a session is minted (or upgraded), so they cannot ride the client that would try to
// sign in before sending them. Every binary field crosses as base64url, the form the daemon parses.

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
const answer = async <T>(response: Response): Promise<T> => {
    if (response.ok) {
        return (await response.json()) as T;
    }
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
    throw new PasskeyRefusedError(response.status, typeof body?.error === `string` ? body.error : `The sandbox refused (${response.status}).`);
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
        throw new Error(`No passkey was used.`);
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
        throw new Error(`No passkey was created.`);
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
        const options = await answer<AuthenticationOptionsJSON>(await post(target, `/system/passkeys/assert/options`, {}));
        return options.available;
    } catch {
        return false;
    }
};

// The whole sign-in: fresh options (a challenge lives five minutes, so none is fetched ahead of the press), the
// ceremony, the assertion exchanged for a session.
export const signInWithPasskey = async (target: SandboxTarget): Promise<DaemonSession> => {
    const options = await answer<AuthenticationOptionsJSON>(await post(target, `/system/passkeys/assert/options`, {}));
    if (!options.available) {
        throw new Error(`No passkey is registered with this sandbox for ${window.location.host}.`);
    }
    const response = await assertPasskey(options);
    return answer<DaemonSession>(await post(target, `/system/passkeys/assert`, { response }));
};

export interface PasskeyRegistered {
    readonly passkey: PasskeySummary;
    // Present when the bearer that registered held no passkey yet: the same proof, upgraded on the spot.
    readonly session?: DaemonSession;
}

// Registers a passkey under `bearer` (a session, or the Google proof of someone enrolling their first under the
// require-passkey policy) and names it `label`.
export const registerPasskey = async (target: SandboxTarget, bearer: string, label: string | undefined): Promise<PasskeyRegistered> => {
    const options = await answer<RegistrationOptionsJSON>(await post(target, `/system/passkeys/register/options`, {}, bearer));
    const response = await createPasskey(options);
    return answer<PasskeyRegistered>(await post(target, `/system/passkeys/register`, { response, ...(label === undefined ? {} : { label }) }, bearer));
};

// The owner's way back in without a passkey: their Google proof plus one of the codes shown when the policy went on.
export const recoverWithCode = async (target: SandboxTarget, bearer: string, code: string): Promise<DaemonSession & { readonly remaining: number }> =>
    answer(await post(target, `/system/session/recover`, { code }, bearer));
