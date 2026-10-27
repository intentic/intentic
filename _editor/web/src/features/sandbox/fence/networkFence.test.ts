// jsdom for the import chain: the passkey ceremony module and the stream reader touch the app's environment at import.
// The fence's one write: a tightening goes as it is, a loosening is signed in the browser first, over the owner keys
// read just before, and never sent at all when nobody here can sign it.
import "@intentic/testing/dom";
import type { EgressOwnerKeysRead } from "@intentic/sandbox-contract/schemas/egress";
import type { DeviceSandboxOp } from "@intentic/sandbox-contract/schemas/devices";

const sent: { op: DeviceSandboxOp; payload: Record<string, unknown> }[] = [];
const read = jest.fn<() => Promise<EgressOwnerKeysRead>>();
const assertPasskey = jest.fn(async (options: { challenge: string; rpId: string }) => ({
    id: `cred`,
    rawId: `cred`,
    type: `public-key` as const,
    response: { clientDataJSON: options.challenge, authenticatorData: `a`, signature: `s` },
}));
jest.mock(`../../../client/sandbox/sandboxRpc`, () => ({ sandboxRpc: { system: { egressOwnerKeys: read } } }));
jest.mock(`../../../client/session/passkeySignIn`, () => ({ assertPasskey, browserSupportsPasskeys: () => true }));
jest.mock(`../../../models/sandbox/devices/useDevices`, () => ({
    manageDeviceSandbox: async (_host: string, _slug: string, op: DeviceSandboxOp, payload: Record<string, unknown>) => {
        sent.push({ op, payload });
        return `done`;
    },
}));

const { sendFence, signStanding } = await import("./networkFence");

const OWNER: EgressOwnerKeysRead = {
    ownerKeys: { rpId: `app.example.test`, origins: [`https://app.example.test`], keys: [{ id: `cred`, alg: -7, jwk: { kty: `EC` } }] },
    credentials: [{ id: `cred`, transports: [`internal`] }],
    owner: true,
    slug: `work`,
    suggestions: [],
};
const door = { hostId: `rog`, target: { machineId: `m1`, environment: `native`, slug: `work` } };
const fenced = {
    policy: { profile: `internet-only` as const, allow: [] },
    revision: `r1`,
    effectiveProfile: `internet-only` as const,
    neverAllow: [],
    state: `enforced` as const,
    blocked: [],
};

beforeEach(() => {
    sent.length = 0;
    read.mockReset();
    assertPasskey.mockClear();
});

test(`what stands between this browser and a signature`, () => {
    expect(signStanding(OWNER)).toBe(`ready`);
    expect(signStanding({ ...OWNER, owner: false })).toBe(`not-owner`);
    expect(signStanding({ ...OWNER, ownerKeys: { ...OWNER.ownerKeys!, keys: [] } })).toBe(`no-passkey`);
    expect(signStanding(OWNER, false)).toBe(`no-webauthn`);
});

test(`turning the fence on is sent as it is, with no ceremony`, async () => {
    await sendFence(door, undefined, fenced.policy);
    expect(sent).toEqual([{ op: `set-egress`, payload: { egress: fenced.policy, onLine: undefined } }]);
    expect(read).not.toHaveBeenCalled();
    expect(assertPasskey).not.toHaveBeenCalled();
});

test(`turning it off is signed by the owner's passkey over the change, then sent with the proof`, async () => {
    read.mockResolvedValue(OWNER);
    await sendFence(door, fenced, { profile: `open`, allow: [] });
    expect(assertPasskey).toHaveBeenCalledWith(expect.objectContaining({ rpId: `app.example.test`, userVerification: `required` }));
    // SAFETY: sendFence puts the EgressProof it built under `egressProof`, the payload field useDevices sends on.
    const proof = sent[0]?.payload[`egressProof`] as { document: string } | undefined;
    expect(JSON.parse(proof?.document ?? `{}`)).toMatchObject({ basedOn: `r1`, slug: `work`, machineId: `m1`, policy: { profile: `open` } });
});

test(`a loosening nobody here can sign never leaves`, async () => {
    read.mockResolvedValue({ ...OWNER, owner: false });
    await expect(sendFence(door, fenced, { profile: `open`, allow: [] })).rejects.toThrow();
    expect(sent).toEqual([]);
});
