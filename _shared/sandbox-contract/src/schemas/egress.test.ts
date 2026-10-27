import { DeviceSandboxFlowSchema } from "./devices.js";
import {
    canonicalEgressOwnerKeysJson,
    canonicalEgressPolicy,
    canonicalEgressPolicyJson,
    EgressAllowSchema,
    EgressChangeDocumentSchema,
    egressChangeDocumentText,
    egressDestinationKind,
    egressOnlyTightens,
    EgressPolicySchema,
    icEgressSetArgs,
    OPEN_EGRESS,
    type EgressPolicy,
} from "./egress.js";

// The fence's words are read by ic (Rust), the machine agent and the editor, so what a destination is, what a
// tightening is and how a policy is spelled to ic are pinned here.

const fenced = (allow: EgressPolicy["allow"]): EgressPolicy => ({ profile: "internet-only", allow });

test("a destination is an address or prefix of either family, a hostname, or the word host", () => {
    expect(egressDestinationKind("192.168.1.20")).toBe("v4");
    expect(egressDestinationKind("10.0.0.0/8")).toBe("v4");
    expect(egressDestinationKind("fd00::/8")).toBe("v6");
    expect(egressDestinationKind("fe80::1")).toBe("v6");
    expect(egressDestinationKind("host")).toBe("host");
    expect(egressDestinationKind("nas.lan")).toBe("name");
    expect(egressDestinationKind("printer")).toBe("name");
    // A typo'd address is never read as a hostname.
    expect(egressDestinationKind("300.1.1.1")).toBeUndefined();
    expect(egressDestinationKind("10.0.0.0/40")).toBeUndefined();
    expect(egressDestinationKind("fd00::zz")).toBeUndefined();
    expect(egressDestinationKind("-bad.lan")).toBeUndefined();
});

test("ports are single ports or upward ranges inside 1-65535", () => {
    expect(EgressAllowSchema.safeParse({ to: "nas.lan", ports: [445, "8000-8100"] }).success).toBe(true);
    expect(EgressAllowSchema.safeParse({ to: "nas.lan", ports: ["8100-8000"] }).success).toBe(false);
    expect(EgressAllowSchema.safeParse({ to: "nas.lan", ports: [0] }).success).toBe(false);
    expect(EgressAllowSchema.safeParse({ to: "nas.lan", ports: ["1-70000"] }).success).toBe(false);
    // Strict: a field this side does not know is refused, never dropped.
    expect(EgressAllowSchema.safeParse({ to: "nas.lan", via: "vpn" }).success).toBe(false);
});

test("two policies that fence the same way spell the same", () => {
    const a = fenced([
        { to: "NAS.lan.", ports: [445, 139, 445] },
        { to: "192.168.1.20", protocol: "tcp", ports: [22] },
    ]);
    const b = fenced([
        { to: "192.168.1.20", ports: [22], protocol: "tcp" },
        { to: "nas.lan", ports: [139, 445] },
        { to: "nas.lan", ports: [445, 139] },
    ]);
    expect(canonicalEgressPolicyJson(a)).toBe(canonicalEgressPolicyJson(b));
    expect(canonicalEgressPolicy(a).allow.map((entry) => entry.to)).toEqual(["192.168.1.20", "nas.lan"]);
});

test("turning the fence on, or dropping an exception, only tightens", () => {
    expect(egressOnlyTightens(OPEN_EGRESS, fenced([{ to: "host" }]))).toBe(true);
    expect(egressOnlyTightens(fenced([{ to: "nas.lan", ports: [445] }, { to: "host" }]), fenced([{ to: "nas.lan", ports: [445] }]))).toBe(true);
    // A note or a card name changes nothing about what is reachable.
    expect(egressOnlyTightens(fenced([{ to: "nas.lan", ports: [445] }]), fenced([{ to: "nas.lan", ports: [445], note: "the NAS", from: "netdisk:nas" }]))).toBe(true);
});

test("turning the fence off, adding an exception or widening one loosens", () => {
    expect(egressOnlyTightens(fenced([]), OPEN_EGRESS)).toBe(false);
    expect(egressOnlyTightens(fenced([]), fenced([{ to: "192.168.1.20" }]))).toBe(false);
    expect(egressOnlyTightens(fenced([{ to: "nas.lan", ports: [445] }]), fenced([{ to: "nas.lan" }]))).toBe(false);
    expect(egressOnlyTightens(fenced([{ to: "nas.lan", protocol: "tcp" }]), fenced([{ to: "nas.lan" }]))).toBe(false);
    // Written differently is asked about, not reasoned about: a narrower prefix still needs the owner.
    expect(egressOnlyTightens(fenced([{ to: "192.168.0.0/16" }]), fenced([{ to: "192.168.1.0/24" }]))).toBe(false);
});

test("ic is handed the canonical policy as one JSON argument", () => {
    const args = icEgressSetArgs("work", fenced([{ to: "nas.lan", ports: [445] }]));
    expect(args.slice(0, 4)).toEqual(["sandbox", "egress", "work", "--policy"]);
    expect(EgressPolicySchema.parse(JSON.parse(args[4] ?? ""))).toEqual({ profile: "internet-only", allow: [{ to: "nas.lan", ports: [445] }] });
});

test("the owner keys hash the same whatever order the daemon lists them in", () => {
    const one = { id: "a", alg: -7 as const, jwk: { kty: "EC", crv: "P-256", x: "x1", y: "y1" }, name: "laptop" };
    const two = { id: "b", alg: -8 as const, jwk: { x: "x2", kty: "OKP", crv: "Ed25519" } };
    expect(canonicalEgressOwnerKeysJson({ rpId: "intentic.dev", origins: ["https://app.intentic.dev", "android:apk-key-hash:abc"], keys: [one, two] })).toBe(
        canonicalEgressOwnerKeysJson({ rpId: "intentic.dev", origins: ["android:apk-key-hash:abc", "https://app.intentic.dev"], keys: [two, { ...one, jwk: { y: "y1", x: "x1", crv: "P-256", kty: "EC" } }] }),
    );
});

test("a signed change parses back from the text it was signed as", () => {
    const document = {
        v: 1 as const,
        purpose: "intentic-egress-change" as const,
        machineId: "m-0123456789",
        environment: "wsl:archlinux",
        slug: "work",
        basedOn: "none",
        policy: fenced([{ to: "nas.lan", ports: [445] }]),
        keys: "0".repeat(64),
        expiresAt: 1_800_000_000_000,
        nonce: "abcdefghijklmnop",
    };
    expect(EgressChangeDocumentSchema.parse(JSON.parse(egressChangeDocumentText(document)))).toEqual(document);
});

test("a set-egress order carries the policy, and refuses a field the agent does not know", () => {
    expect(DeviceSandboxFlowSchema.safeParse({ op: "set-egress", slug: "work", egress: fenced([]) }).success).toBe(true);
    expect(DeviceSandboxFlowSchema.safeParse({ op: "set-egress", slug: "work", egress: { profile: "internet-only", allow: [], extra: true } }).success).toBe(false);
});
