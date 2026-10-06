// The browser half of a passkey ceremony: the daemon's base64url options become the bytes WebAuthn takes, the
// credential's bytes come back as the base64url the daemon parses, and every call carries the daemon's own refusal.
import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { passkeyOffered, PasskeyRefusedError, recoverWithCode, registerPasskey, signInWithPasskey } from "./passkeySignIn";

const TARGET = { sandboxId: `sb-1`, base: `https://daemon.test`, connectToken: `connect` };

const bytes = (...values: number[]): ArrayBuffer => Uint8Array.from(values).buffer as ArrayBuffer;

// jsdom has no WebAuthn; these stand in for the classes the module checks a credential against.
class FakeAssertion {
    constructor(
        readonly clientDataJSON: ArrayBuffer,
        readonly authenticatorData: ArrayBuffer,
        readonly signature: ArrayBuffer,
        readonly userHandle: ArrayBuffer | null,
    ) {}
}
class FakeAttestation {
    constructor(
        readonly clientDataJSON: ArrayBuffer,
        readonly attestationObject: ArrayBuffer,
    ) {}
    getTransports(): string[] {
        return [`internal`];
    }
}
class FakeCredential {
    constructor(
        readonly id: string,
        readonly rawId: ArrayBuffer,
        readonly response: FakeAssertion | FakeAttestation,
    ) {}
}

const get = jest.fn();
const create = jest.fn();
const fetchMock = jest.fn();

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": `application/json` } });

// The JSON body and headers the module sent on call `index`.
const sent = (index: number): { url: string; body: Record<string, unknown>; headers: Record<string, string> } => {
    const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
    return { url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> };
};

beforeEach(() => {
    stubGlobal(`PublicKeyCredential`, FakeCredential);
    stubGlobal(`AuthenticatorAssertionResponse`, FakeAssertion);
    stubGlobal(`AuthenticatorAttestationResponse`, FakeAttestation);
    stubGlobal(`fetch`, fetchMock);
    Object.defineProperty(navigator, `credentials`, { value: { get, create }, configurable: true });
    get.mockReset();
    create.mockReset();
    fetchMock.mockReset();
});

afterEach(() => unstubAllGlobals());

it(`signs in: fresh options, the browser's get() over their bytes, the assertion posted as base64url, a session back`, async () => {
    fetchMock
        .mockResolvedValueOnce(
            json({
                rpId: `app.test`,
                challenge: `AQID`,
                timeout: 1,
                userVerification: `required`,
                allowCredentials: [{ type: `public-key`, id: `BAUG`, transports: [`internal`] }],
                available: true,
            }),
        )
        .mockResolvedValueOnce(json({ token: `sess`, expiresAt: 1, email: `o@x.com` }));
    get.mockResolvedValue(new FakeCredential(`BAUG`, bytes(4, 5, 6), new FakeAssertion(bytes(7), bytes(8, 9), bytes(10), null)));

    expect(await signInWithPasskey(TARGET)).toEqual({ token: `sess`, expiresAt: 1, email: `o@x.com` });

    const [{ publicKey }] = get.mock.calls[0] as [{ publicKey: PublicKeyCredentialRequestOptions }];
    expect([...new Uint8Array(publicKey.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(publicKey.rpId).toBe(`app.test`);
    expect(publicKey.userVerification).toBe(`required`);
    expect([...new Uint8Array(publicKey.allowCredentials![0]!.id as ArrayBuffer)]).toEqual([4, 5, 6]);
    expect(publicKey.allowCredentials![0]!.transports).toEqual([`internal`]);

    expect(sent(0).url).toBe(`https://daemon.test/system/passkeys/assert/options`);
    expect(sent(0).headers).toEqual({ "content-type": `application/json`, "x-intentic-connect": `connect` });
    expect(sent(1).url).toBe(`https://daemon.test/system/passkeys/assert`);
    expect(sent(1).body).toEqual({
        response: { id: `BAUG`, rawId: `BAUG`, type: `public-key`, response: { clientDataJSON: `Bw`, authenticatorData: `CAk`, signature: `Cg` } },
    });
});

it(`refuses to run a ceremony the daemon says cannot succeed, before any browser dialog`, async () => {
    fetchMock.mockResolvedValueOnce(
        json({ rpId: `app.test`, challenge: `AQID`, timeout: 1, userVerification: `required`, allowCredentials: [], available: false }),
    );
    await expect(signInWithPasskey(TARGET)).rejects.toThrow(/No passkey is registered with this sandbox/);
    expect(get).not.toHaveBeenCalled();
});

it(`registers under the given bearer: user handle and exclusions as bytes, the attestation back as base64url, the label along`, async () => {
    fetchMock
        .mockResolvedValueOnce(
            json({
                rp: { id: `app.test`, name: `work` },
                user: { id: `AQI`, name: `o@x.com`, displayName: `o@x.com · work` },
                challenge: `AwQ`,
                pubKeyCredParams: [{ type: `public-key`, alg: -7 }],
                timeout: 1,
                attestation: `none`,
                excludeCredentials: [{ type: `public-key`, id: `BQ` }],
                authenticatorSelection: { residentKey: `required`, requireResidentKey: true, userVerification: `required` },
            }),
        )
        .mockResolvedValueOnce(json({ passkey: { id: `Bg` }, session: { token: `sess`, expiresAt: 1, email: `o@x.com` } }));
    create.mockResolvedValue(new FakeCredential(`Bg`, bytes(6), new FakeAttestation(bytes(7), bytes(8))));

    const registered = await registerPasskey(TARGET, `google-proof`, `laptop`);
    expect(registered).toEqual({ passkey: expect.objectContaining({ id: `Bg` }), session: { token: `sess`, expiresAt: 1, email: `o@x.com` } });

    const [{ publicKey }] = create.mock.calls[0] as [{ publicKey: PublicKeyCredentialCreationOptions }];
    expect([...new Uint8Array(publicKey.user.id as ArrayBuffer)]).toEqual([1, 2]);
    expect([...new Uint8Array(publicKey.challenge as ArrayBuffer)]).toEqual([3, 4]);
    expect([...new Uint8Array(publicKey.excludeCredentials![0]!.id as ArrayBuffer)]).toEqual([5]);
    expect(publicKey.attestation).toBe(`none`);
    expect(publicKey.authenticatorSelection).toEqual({ residentKey: `required`, requireResidentKey: true, userVerification: `required` });

    expect(sent(0).headers).toMatchObject({ authorization: `Bearer google-proof` });
    expect(sent(1).body).toEqual({
        response: {
            id: `Bg`,
            rawId: `Bg`,
            type: `public-key`,
            response: { clientDataJSON: `Bw`, attestationObject: `CA`, transports: [`internal`] },
        },
        label: `laptop`,
    });
});

it(`the daemon's refusal comes back with its status and its own words`, async () => {
    fetchMock.mockResolvedValueOnce(json({ error: `that recovery code is not one of yours, or was already used` }, 403));
    const refused = recoverWithCode(TARGET, `google-proof`, `abcde`);
    await expect(refused).rejects.toBeInstanceOf(PasskeyRefusedError);
    await expect(refused).rejects.toMatchObject({ status: 403, message: `that recovery code is not one of yours, or was already used` });
    expect(sent(0).body).toEqual({ code: `abcde` });
    expect(sent(0).headers).toMatchObject({ authorization: `Bearer google-proof` });
});

it(`is offered only where a ceremony can run: WebAuthn present, and the daemon holding a passkey for this origin`, async () => {
    fetchMock.mockResolvedValueOnce(json({ available: true }));
    expect(await passkeyOffered(TARGET)).toBe(true);
    fetchMock.mockResolvedValueOnce(json({ available: false }));
    expect(await passkeyOffered(TARGET)).toBe(false);
    // A daemon that predates the route.
    fetchMock.mockResolvedValueOnce(new Response(`not found`, { status: 404 }));
    expect(await passkeyOffered(TARGET)).toBe(false);

    stubGlobal(`PublicKeyCredential`, undefined);
    fetchMock.mockReset();
    expect(await passkeyOffered(TARGET)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
});
