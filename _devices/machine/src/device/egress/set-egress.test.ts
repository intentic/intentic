import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { base64url } from "@intentic/base/webauthn";
import type { AuthenticationResponse } from "@intentic/sandbox-contract/schemas/system";
import {
    EGRESS_PROOF_MAX_AGE_MS,
    type EgressChangeDocument,
    egressChangeDocumentText,
    type EgressOwnerKeys,
    type EgressPolicy,
    type EgressStatus,
    type EgressTrustedKey,
    OPEN_EGRESS,
} from "@intentic/sandbox-contract/schemas/egress";
import type { EgressPin, EgressPinStore, PinnedSandbox } from "./pins.js";
import { egressChallengeOf, looseningText, ownerKeysDigest } from "./proof.js";
import { type SetEgressAsk, type SetEgressSeams, egressStatusFrom, setEgressWith } from "./set-egress.js";

/* The set-egress decision against real WebAuthn bytes: key pairs from node:crypto, authenticator data and client data
   built here the way a browser and an authenticator build them, so the verifier reads the wire format. */

const RP_ID = "app.intentic.dev";
const ORIGIN = "https://app.intentic.dev";
const NOW = 1_800_000_000_000;
const MACHINE = "m-0b7c6a4e-1d2f-4a3b-9c8d-7e6f5a4b3c2d";
const ENVIRONMENT = "wsl:archlinux";
const SLUG = "nas-box";
const SANDBOX: PinnedSandbox = { slug: SLUG, sandboxId: "a1b2c3d4e5f6" };

const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();

type Alg = -7 | -257 | -8;
const pairFor = (alg: Alg): { publicKey: KeyObject; privateKey: KeyObject } =>
    alg === -7 ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : alg === -257 ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ed25519");

interface GetOptions {
    readonly challenge?: string;
    readonly origin?: string;
    readonly rpId?: string;
    readonly type?: string;
    readonly crossOrigin?: boolean;
    readonly userPresent?: boolean;
    readonly userVerified?: boolean;
    readonly counter?: number;
    readonly tamper?: boolean;
}

// A passkey in software: `key` is what the daemon would hand over, `get` an assertion over a document's text.
const passkey = (alg: Alg = -7, name?: string) => {
    const { publicKey, privateKey } = pairFor(alg);
    const id = base64url.encode(randomBytes(16));
    const jwk = Object.fromEntries(Object.entries(publicKey.export({ format: "jwk" })).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const key: EgressTrustedKey = name === undefined ? { id, alg, jwk } : { id, alg, jwk, name };
    const get = (document: string, options: GetOptions = {}): AuthenticationResponse => {
        const flags = (options.userPresent === false ? 0 : 0x01) | (options.userVerified === false ? 0 : 0x04);
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(options.counter ?? 0);
        const authData = Buffer.concat([sha256(Buffer.from(options.rpId ?? RP_ID, "utf8")), Buffer.from([flags]), counter]);
        const clientData = Buffer.from(
            JSON.stringify({
                type: options.type ?? "webauthn.get",
                challenge: options.challenge ?? egressChallengeOf(document),
                origin: options.origin ?? ORIGIN,
                crossOrigin: options.crossOrigin ?? false,
            }),
            "utf8",
        );
        const signed = Buffer.concat([authData, sha256(clientData)]);
        const signature = alg === -8 ? sign(undefined, signed, privateKey) : sign("sha256", signed, privateKey);
        if (options.tamper === true) {
            signature[signature.length - 1] = (signature.at(-1) ?? 0) ^ 0xff;
        }
        return {
            id,
            rawId: id,
            type: "public-key",
            response: { clientDataJSON: base64url.encode(clientData), authenticatorData: base64url.encode(authData), signature: base64url.encode(signature) },
        };
    };
    return { key, get };
};

const ownerOf = (...keys: EgressTrustedKey[]): EgressOwnerKeys => ({ rpId: RP_ID, origins: [ORIGIN, "android:apk-key-hash:abc"], keys });

const FENCED: EgressPolicy = { profile: "internet-only", allow: [] };
const WITH_NAS: EgressPolicy = { profile: "internet-only", allow: [{ to: "192.168.1.20", ports: [445], protocol: "tcp" }] };

const statusOf = (policy: EgressPolicy, revision: string): EgressStatus => ({
    policy,
    revision,
    effectiveProfile: policy.profile,
    neverAllow: [],
    state: policy.profile === "open" ? "off" : "enforced",
    blocked: [],
});

const memoryPins = (initial: EgressPin[] = []): EgressPinStore & { pins: EgressPin[] } => {
    const store = {
        pins: initial,
        read: async ({ slug, sandboxId }: PinnedSandbox) => await Promise.resolve(store.pins.find((pin) => pin.slug === slug && pin.sandboxId === sandboxId)),
        list: async (slug?: string) => await Promise.resolve(store.pins.filter((pin) => slug === undefined || pin.slug === slug)),
        write: async (pin: EgressPin) => {
            store.pins = [...store.pins.filter((held) => held.slug !== pin.slug), pin];
            await Promise.resolve();
        },
        reset: async (slug: string) => {
            const before = store.pins.length;
            store.pins = store.pins.filter((held) => held.slug !== slug);
            return await Promise.resolve(before - store.pins.length);
        },
    };
    return store;
};

const pinOf = (owner: EgressOwnerKeys, counters: Record<string, number> = {}): EgressPin => ({
    slug: SLUG,
    sandboxId: SANDBOX.sandboxId,
    owner,
    counters,
    pinnedAt: NOW - 86_400_000,
    pinnedBy: "https://box.example",
});

interface World {
    readonly seams: SetEgressSeams;
    readonly pins: ReturnType<typeof memoryPins>;
    readonly applied: EgressPolicy[];
    readonly audited: { tool: string; ok: boolean; detail: string }[];
}

const world = (current: EgressStatus, pins: EgressPin[] = []): World => {
    const store = memoryPins(pins);
    const applied: EgressPolicy[] = [];
    const audited: World["audited"] = [];
    return {
        pins: store,
        applied,
        audited,
        seams: {
            sandbox: async () => await Promise.resolve(SANDBOX),
            status: async () => await Promise.resolve(current),
            apply: async (_slug, policy) => {
                applied.push(policy);
                await Promise.resolve();
            },
            identity: async () => await Promise.resolve({ machineId: MACHINE, environment: ENVIRONMENT }),
            pins: store,
            audit: (entry) => audited.push(entry),
            now: () => NOW,
        },
    };
};

const documentOf = (owner: EgressOwnerKeys, change: Partial<EgressChangeDocument> = {}): string =>
    egressChangeDocumentText({
        v: 1,
        purpose: "intentic-egress-change",
        machineId: MACHINE,
        environment: ENVIRONMENT,
        slug: SLUG,
        basedOn: "r7",
        policy: WITH_NAS,
        keys: ownerKeysDigest(owner),
        expiresAt: NOW + 60_000,
        nonce: "n0nce-n0nce-n0nce",
        ...change,
    });

const ask = (change: Partial<SetEgressAsk> = {}): SetEgressAsk => ({ slug: SLUG, policy: WITH_NAS, proof: undefined, ownerKeys: undefined, via: "https://box.example", ...change });

const refusal = async (promise: Promise<string>): Promise<string> => {
    const error: unknown = await promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    return error instanceof Error ? error.message : "";
};

describe("a change that only tightens", () => {
    test("is carried out with no proof, and the first one pins the daemon-filled passkeys with an audit line", async () => {
        const { key } = passkey(-7, "Phone");
        const owner = ownerOf(key);
        const w = world(statusOf(OPEN_EGRESS, "none"));
        const said = await setEgressWith(ask({ policy: FENCED, ownerKeys: owner }), w.seams, () => {});
        expect(w.applied).toEqual([FENCED]);
        expect(said).toContain("now trusts your passkey");
        expect(w.pins.pins).toHaveLength(1);
        expect(w.pins.pins[0]).toMatchObject({ slug: SLUG, sandboxId: SANDBOX.sandboxId, owner, counters: {}, pinnedBy: "https://box.example" });
        expect(w.audited.some((entry) => entry.detail.includes("on first use") && entry.detail.includes("Phone"))).toBe(true);
    });

    test("never replaces a pin, whatever owner keys the daemon hands over", async () => {
        const pinned = ownerOf(passkey().key);
        const w = world(statusOf(WITH_NAS, "r7"), [pinOf(pinned)]);
        await setEgressWith(ask({ policy: FENCED, ownerKeys: ownerOf(passkey().key) }), w.seams, () => {});
        expect(w.applied).toEqual([FENCED]);
        expect(w.pins.pins[0]?.owner).toEqual(pinned);
    });

    test("pins nothing when the daemon hands over no passkeys", async () => {
        const w = world(statusOf(OPEN_EGRESS, "none"));
        await setEgressWith(ask({ policy: FENCED, ownerKeys: ownerOf() }), w.seams, () => {});
        expect(w.applied).toEqual([FENCED]);
        expect(w.pins.pins).toEqual([]);
    });
});

describe("a loosening", () => {
    const signer = passkey(-7, "Phone");
    const owner = ownerOf(signer.key);
    const setup = (pins: EgressPin[] = [pinOf(owner)]): World => world(statusOf(FENCED, "r7"), pins);

    test("without a proof is refused with what it opens", async () => {
        const w = setup();
        expect(await refusal(setEgressWith(ask(), w.seams, () => {}))).toBe(
            'This change opens 192.168.1.20 port 445/tcp to "nas-box": sign it with your passkey.',
        );
        expect(w.applied).toEqual([]);
        expect(w.audited.at(-1)).toMatchObject({ ok: false });
    });

    test("with no pin says how to get one", async () => {
        const w = setup([]);
        const text = documentOf(owner);
        const message = await refusal(setEgressWith(ask({ proof: { document: text, assertion: signer.get(text) }, ownerKeys: owner }), w.seams, () => {}));
        expect(message).toContain('this machine has no passkey pinned for "nas-box"');
        expect(message).toContain("`ic sandbox egress nas-box`");
        expect(w.applied).toEqual([]);
    });

    test("a pin left by an earlier sandbox of the same name is no pin", async () => {
        const w = setup([{ ...pinOf(owner), sandboxId: "ffffffffffff" }]);
        const text = documentOf(owner);
        expect(await refusal(setEgressWith(ask({ proof: { document: text, assertion: signer.get(text) } }), w.seams, () => {}))).toContain("no passkey pinned");
    });

    for (const alg of [-7, -257, -8] as const) {
        test(`signed by a pinned ${alg} key is carried out, and the counter kept`, async () => {
            const key = passkey(alg);
            const keys = ownerOf(key.key);
            const w = setup([pinOf(keys)]);
            const text = documentOf(keys);
            const said = await setEgressWith(ask({ proof: { document: text, assertion: key.get(text, { counter: 5 }) }, ownerKeys: keys }), w.seams, () => {});
            expect(said).toContain("under your passkey");
            expect(w.applied).toEqual([WITH_NAS]);
            expect(w.pins.pins[0]?.counters).toEqual({ [key.key.id]: 5 });
        });
    }

    test("turning the fence off is a loosening too", async () => {
        const w = setup();
        const text = documentOf(owner, { policy: OPEN_EGRESS });
        expect(looseningText(SLUG, FENCED, OPEN_EGRESS)).toContain("turns the egress fence");
        await setEgressWith(ask({ policy: OPEN_EGRESS, proof: { document: text, assertion: signer.get(text) } }), w.seams, () => {});
        expect(w.applied).toEqual([OPEN_EGRESS]);
    });

    test("a passkey the daemon adds is never pinned by a loosening, however it was signed", async () => {
        const added = passkey(-8, "Laptop");
        const current = ownerOf(signer.key, added.key);
        const w = setup([pinOf(owner, { [signer.key.id]: 2 })]);
        const text = documentOf(current);
        const said = await setEgressWith(ask({ proof: { document: text, assertion: signer.get(text, { counter: 3 }) }, ownerKeys: current }), w.seams, () => {});
        expect(said).toContain("--reset");
        expect(w.applied).toEqual([WITH_NAS]);
        expect(w.pins.pins[0]?.owner).toEqual(owner);
        expect(w.pins.pins[0]?.counters).toEqual({ [signer.key.id]: 3 });
        expect(w.pins.pins[0]?.replacedAt).toBeUndefined();
    });

    test("a passkey the owner removed drops off the pin", async () => {
        const other = passkey(-8, "Old phone");
        const both = ownerOf(signer.key, other.key);
        const w = setup([pinOf(both, { [signer.key.id]: 2, [other.key.id]: 9 })]);
        const current = ownerOf(signer.key);
        const text = documentOf(current);
        const said = await setEgressWith(ask({ proof: { document: text, assertion: signer.get(text, { counter: 3 }) }, ownerKeys: current }), w.seams, () => {});
        expect(said).toContain("no longer trusts the passkeys you removed");
        expect(w.pins.pins[0]?.owner).toEqual(current);
        expect(w.pins.pins[0]?.counters).toEqual({ [signer.key.id]: 3 });
        expect(w.pins.pins[0]?.replacedAt).toBe(NOW);
    });

    // Each way a proof can fail to be this change, signed by the owner, now: one sentence each, and nothing applied.
    const refusals: { name: string; build: () => { text: string; assertion: AuthenticationResponse; ownerKeys?: EgressOwnerKeys }; says: string }[] = [
        { name: "a document that is not one", build: () => ({ text: "{}", assertion: signer.get("{}") }), says: "not an intentic egress change" },
        {
            name: "another purpose",
            build: () => {
                const text = documentOf(owner).replace("intentic-egress-change", "intentic-other");
                return { text, assertion: signer.get(text) };
            },
            says: "not an intentic egress change",
        },
        { name: "another machine", build: () => signedDoc({ machineId: "m-other" }), says: "for another machine" },
        { name: "another environment", build: () => signedDoc({ environment: "windows" }), says: "another side of this computer" },
        { name: "another sandbox", build: () => signedDoc({ slug: "other" }), says: 'for sandbox "other"' },
        { name: "a stale revision", build: () => signedDoc({ basedOn: "r6" }), says: "changed since you signed" },
        { name: "another policy", build: () => signedDoc({ policy: { profile: "internet-only", allow: [{ to: "10.0.0.1" }] } }), says: "not the one this request asks for" },
        { name: "an expired one", build: () => signedDoc({ expiresAt: NOW - 1 }), says: "expired" },
        { name: "one holding too long", build: () => signedDoc({ expiresAt: NOW + EGRESS_PROOF_MAX_AGE_MS + 1 }), says: "more than 5 minutes ahead" },
        {
            name: "owner keys other than the ones signed over",
            build: () => ({ ...signedDoc(), ownerKeys: ownerOf(signer.key, passkey().key) }),
            says: "not the ones you signed over",
        },
        {
            name: "an unpinned passkey",
            build: () => {
                const text = documentOf(owner);
                return { text, assertion: passkey().get(text) };
            },
            says: "not one this machine pinned",
        },
        { name: "a ceremony of another type", build: () => signedDoc({}, { type: "webauthn.create" }), says: "expected webauthn.get" },
        { name: "another challenge", build: () => signedDoc({}, { challenge: base64url.encode(randomBytes(32)) }), says: "challenge does not match" },
        { name: "an unpinned origin", build: () => signedDoc({}, { origin: "https://evil.example" }), says: "ceremony ran on https://evil.example" },
        { name: "a cross-origin ceremony", build: () => signedDoc({}, { crossOrigin: true }), says: "cross-origin" },
        { name: "another relying party", build: () => signedDoc({}, { rpId: "evil.example" }), says: "scoped to another site" },
        { name: "no user presence", build: () => signedDoc({}, { userPresent: false }), says: "user presence" },
        { name: "no user verification", build: () => signedDoc({}, { userVerified: false }), says: "did not verify the user" },
        { name: "a bad signature", build: () => signedDoc({}, { tamper: true }), says: "signature does not verify" },
        { name: "a counter that went back", build: () => signedDoc({}, { counter: 4 }), says: "counter did not advance" },
    ];
    const signedDoc = (change: Partial<EgressChangeDocument> = {}, options: GetOptions = {}) => {
        const text = documentOf(owner, change);
        return { text, assertion: signer.get(text, options) };
    };
    for (const { name, build, says } of refusals) {
        test(`is refused for ${name}`, async () => {
            const w = setup([pinOf(owner, { [signer.key.id]: 4 })]);
            const { text, assertion, ownerKeys } = build();
            const message = await refusal(setEgressWith(ask({ proof: { document: text, assertion }, ownerKeys: ownerKeys ?? owner }), w.seams, () => {}));
            expect(message).toContain(says);
            expect(w.applied).toEqual([]);
        });
    }

    test("a counting key's counter is spent once checked: the same assertion twice is refused", async () => {
        const w = setup();
        const text = documentOf(owner);
        const proof = { document: text, assertion: signer.get(text, { counter: 9 }) };
        await setEgressWith(ask({ proof }), w.seams, () => {});
        expect(await refusal(setEgressWith(ask({ proof }), world(statusOf(FENCED, "r7"), w.pins.pins).seams, () => {}))).toContain("counter did not advance");
    });
});

test("ic's status line is read off the end of its output, and anything else is no status", () => {
    const line = JSON.stringify(statusOf(FENCED, "r7"));
    expect(egressStatusFrom(`note: something\n${line}\n`)).toEqual(statusOf(FENCED, "r7"));
    expect(egressStatusFrom("error: unrecognized subcommand 'egress'")).toBeUndefined();
    expect(egressStatusFrom("{not json")).toBeUndefined();
});
