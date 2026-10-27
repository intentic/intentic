import { createHash } from "node:crypto";
import { canonicalEgressOwnerKeysJson, EgressChangeDocumentSchema, type EgressOwnerKeys, type EgressStatus } from "@intentic/sandbox-contract/schemas/egress";
import {
    allows,
    blockedException,
    changeToSign,
    exceptionOf,
    fenceLine,
    heldPolicy,
    heldRevision,
    icEgressCommand,
    loosens,
    PROOF_LIFETIME_MS,
    samePolicy,
    withException,
    withoutException,
} from "./egressFlow";

// What the network fence section sends and what it signs. Tightening needs nothing; loosening is signed over the
// contract's document, whose challenge is the sha256 of its exact text and whose `keys` names the owner keys the daemon
// hands the machine, so both halves can be checked against what the machine agent will compute.

const OPEN = { profile: `open` as const, allow: [] };
const NAS = { to: `nas.lan`, ports: [445], protocol: `tcp` as const };
const FENCED = { profile: `internet-only` as const, allow: [NAS] };

const status = (overrides: Partial<EgressStatus> = {}): EgressStatus => ({
    policy: FENCED,
    revision: `r7`,
    effectiveProfile: `internet-only`,
    neverAllow: [],
    state: `enforced`,
    blocked: [],
    ...overrides,
});

test(`nothing held reads as open, at no revision`, () => {
    expect(heldPolicy(undefined)).toEqual(OPEN);
    expect(heldRevision(undefined)).toBe(`none`);
    expect(heldRevision(status())).toBe(`r7`);
});

test(`fencing, dropping an exception and narrowing nothing is a tightening; anything else loosens`, () => {
    expect(loosens(OPEN, FENCED)).toBe(false);
    expect(loosens(FENCED, { ...FENCED, allow: [] })).toBe(false);
    expect(loosens(FENCED, OPEN)).toBe(true);
    expect(loosens(FENCED, withException(FENCED, { to: `10.0.0.5` }))).toBe(true);
    // The same way through, labelled differently, opens nothing new.
    expect(loosens(FENCED, { ...FENCED, allow: [{ ...NAS, note: `photos` }] })).toBe(false);
});

test(`exceptions are added once and removed by place`, () => {
    expect(withException(FENCED, { ...NAS, note: `again` })).toBe(FENCED);
    const two = withException(FENCED, { to: `host` });
    expect(two.allow.map((entry) => entry.to)).toEqual([`host`, `nas.lan`]);
    expect(withoutException(two, 0)).toEqual(FENCED);
    expect(samePolicy(FENCED, { profile: `internet-only`, allow: [{ protocol: `tcp`, ports: [445], to: `NAS.lan` }] })).toBe(true);
});

test(`a refused destination becomes the exception that lets exactly it through`, () => {
    expect(blockedException({ to: `192.168.1.9`, port: 22, protocol: `tcp`, packets: 3 })).toEqual({ to: `192.168.1.9`, ports: [22], protocol: `tcp`, from: `owner` });
    expect(blockedException({ to: `10.0.0.1`, protocol: `other`, packets: 1 })).toEqual({ to: `10.0.0.1`, from: `owner` });
    expect(allows(FENCED, { to: `nas.lan`, ports: [445], protocol: `tcp`, from: `owner` })).toBe(true);
});

test(`the exception form is read through the contract's own schema`, () => {
    expect(exceptionOf({ to: ` 192.168.1.0/24 `, ports: `22, 8000-8100`, protocol: `tcp`, note: ` lab ` })).toEqual({
        entry: { to: `192.168.1.0/24`, ports: [22, `8000-8100`], protocol: `tcp`, note: `lab`, from: `owner` },
    });
    expect(exceptionOf({ to: `nas.lan`, ports: ``, protocol: `both`, note: `` })).toEqual({ entry: { to: `nas.lan`, from: `owner` } });
    expect(`problem` in exceptionOf({ to: `nas.lan`, ports: `99999`, protocol: `both`, note: `` })).toBe(true);
    expect(`problem` in exceptionOf({ to: `300.1.1.1`, ports: ``, protocol: `both`, note: `` })).toBe(true);
});

test(`the line says the profile, how it stands and how many exceptions`, () => {
    expect(fenceLine(undefined).tone).toBe(`default`);
    expect(fenceLine(status())).toEqual({ text: expect.stringContaining(`1`), tone: `success` });
    expect(fenceLine(status({ state: `failed`, reason: `no nft` })).tone).toBe(`danger`);
    expect(fenceLine(status({ advisory: true })).tone).toBe(`warning`);
    expect(fenceLine(status({ state: `pending` })).tone).toBe(`warning`);
});

test(`the machine's own command sets the same canonical policy, quoted for a shell`, () => {
    expect(icEgressCommand(`work`, FENCED)).toBe(
        `ic sandbox egress work --policy '{"allow":[{"to":"nas.lan","ports":[445],"protocol":"tcp"}],"profile":"internet-only"}'`,
    );
});

test(`a loosening is signed over the contract's document, its challenge the sha256 of that exact text`, async () => {
    const ownerKeys: EgressOwnerKeys = {
        rpId: `app.example.test`,
        origins: [`https://app.example.test`],
        keys: [{ id: `cred`, alg: -7, jwk: { y: `y`, x: `x`, kty: `EC`, crv: `P-256` } }],
    };
    const target = { machineId: `0123456789abcdef`, environment: `native`, slug: `work` };
    const { document, text, challenge } = await changeToSign(target, `r7`, OPEN, ownerKeys, { now: 1_000, nonce: `abcdefghijklmnopqrstuvwx` });
    expect(EgressChangeDocumentSchema.parse(JSON.parse(text))).toEqual({ ...document, policy: OPEN });
    expect(document).toMatchObject({ v: 1, purpose: `intentic-egress-change`, basedOn: `r7`, slug: `work`, environment: `native`, expiresAt: 1_000 + PROOF_LIFETIME_MS });
    expect(document.keys).toBe(createHash(`sha256`).update(canonicalEgressOwnerKeysJson(ownerKeys)).digest(`hex`));
    expect(challenge).toBe(createHash(`sha256`).update(text).digest(`base64url`));
});
