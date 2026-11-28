import type { ApprovalPasskeyOptions, ApprovalSummary, ApprovalUpsert } from "@intentic/sandbox-contract/schemas/approvals";
import { host } from "./host";
import { t } from "./i18n";

// (2026-11-28) Approving an action with a passkey: the daemon's request for this one item (POST /approvals/{id}/passkey,
// whose challenge is the digest of exactly what will be done), the browser's `navigator.credentials.get`, and the
// assertion posted back with the yes. The daemon keeps the passkey's signature with the yes and hands it to the extension
// carrying the item out. Every binary field crosses as base64url, the form the daemon parses; the editor's own sign-in
// helpers do the same (_editor/web/src/client/session/passkeySignIn.ts), which an extension cannot import.

// The browser's assertion as the approve carries it (the contract's AuthenticationResponse).
type Assertion = NonNullable<Extract<ApprovalUpsert, { kind: `action` }>[`passkey`]>;

// What the item's filer asked for: `offered` (a second way to approve) or `required` (the only way). Only an action an
// extension carries out takes one, since the performer's digest is what the passkey signs.
export const passkeyCosignOf = (item: ApprovalSummary): `offered` | `required` | undefined =>
    item.kind === `action` && item.performer !== undefined ? item.cosign : undefined;

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
        .replace(/=+$/u, ``);

// The browser's assertion over the daemon's options, as the daemon parses it; throws when no passkey answered.
const assert = async (options: ApprovalPasskeyOptions): Promise<Assertion> => {
    const credential = await navigator.credentials.get({
        publicKey: {
            rpId: options.rpId,
            challenge: toBytes(options.challenge),
            timeout: options.timeout,
            userVerification: options.userVerification,
            allowCredentials: options.allowCredentials.map((entry) => ({
                type: entry.type,
                id: toBytes(entry.id),
                // SAFETY: the daemon lists the transports the browser reported at registration, which are this type's own words.
                transports: (entry.transports ?? []) as AuthenticatorTransport[],
            })),
        },
    });
    if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
        throw new Error(t(`approvalsView.passkeyNotUsed`));
    }
    const { response } = credential;
    const userHandle = response.userHandle === null ? {} : { userHandle: toBase64Url(response.userHandle) };
    return {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: `public-key`,
        response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            authenticatorData: toBase64Url(response.authenticatorData),
            signature: toBase64Url(response.signature),
            ...userHandle,
        },
    };
};

// Approves `item` with the person's passkey: asks the daemon for this item's request, runs the ceremony, and saves the
// yes with the assertion through `save` (the queue's own upsert). Throws, with words a person reads, when the browser
// has no passkeys, the person holds none on this sandbox, or none was used.
export const approveWithPasskey = async (item: ApprovalSummary, save: (upsert: ApprovalUpsert) => Promise<void>): Promise<void> => {
    if (item.kind !== `action` || !(`PublicKeyCredential` in window)) {
        throw new Error(t(`approvalsView.passkeyUnsupported`));
    }
    const options = await host().sandbox.rpc.approvals.passkeyOptions({ id: item.id });
    if (!options.available) {
        throw new Error(t(`approvalsView.passkeyNoneHeld`));
    }
    await save({ ...item, status: `approved`, passkey: await assert(options) });
};
