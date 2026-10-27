// egress: what a sandbox may reach on the networks around the machine it runs on, enforced by `ic` on the host.
import { z } from "zod";
import { AuthenticationResponseSchema } from "./system.js";

// WHY THIS LIVES ON THE HOST. The agent is root in its container, a `vpn` or `exit` card gives the container
// NET_ADMIN, and the Docker capability makes it privileged, so no rule inside the container can fence it. `ic` puts the
// rules in the host's network namespace (one nftables table of its own, `inet intentic_egress`), where the sandbox's
// traffic meets the uplink, and it is the only writer of the policy: the daemon shows it and asks for changes, the
// machine agent decides whether a change may be carried out, ic carries it out. A sandbox is matched by its own network
// when ic made that network for it, and by its addresses when something else did (Docker Compose), which ic follows
// through docker's events so a recreate is fenced within a second.

// `open` is today's behaviour, nothing fenced. `internet-only` refuses every private, link-local, shared and
// multicast range and the machine itself, except the listed `allow` entries; the internet stays reachable. A profile
// further down this list is tighter; a later one (an allowlist of hostnames) goes after the last.
export const EgressProfileSchema = z.enum(["open", "internet-only"]);
export type EgressProfile = z.infer<typeof EgressProfileSchema>;
export const EGRESS_PROFILE_RANK = { open: 0, "internet-only": 1 } as const satisfies Record<EgressProfile, number>;

// What `internet-only` refuses. RFC 1918 and the loopback/unspecified blocks, CGNAT space (Tailscale lives there),
// link-local (where cloud metadata answers, 169.254.169.254), the documentation, benchmarking and reserved blocks,
// multicast; for IPv6 the unique-local (fc00::/7), link-local, site-local and multicast prefixes and the IPv4-mapped
// space, so a mapped address cannot walk around the IPv4 set. The machine's own addresses are refused separately (the
// input hook), whatever they are.
export const EGRESS_PRIVATE_V4: readonly string[] = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
];
export const EGRESS_PRIVATE_V6: readonly string[] = ["::/128", "::1/128", "::ffff:0:0/96", "64:ff9b:1::/48", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"];

// THE MACHINE ITSELF, as an `allow` target: whatever addresses the host has (its LAN address, the bridge gateway, the
// WSL side every distro shares). Kept a word, since those addresses change and only ic can read them.
export const EGRESS_HOST = "host";

const HOSTNAME = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/u;
const IPV4 = z.ipv4();
const CIDRV4 = z.cidrv4();
const IPV6 = z.ipv6();
const CIDRV6 = z.cidrv6();

export type EgressDestinationKind = "v4" | "v6" | "host" | "name";
// Which kind a destination is, or undefined when it is none: an address or a prefix of either family, the word
// `host`, or a hostname ic resolves on the host every time it applies the rules (a NAS named on the LAN's DNS).
export const egressDestinationKind = (value: string): EgressDestinationKind | undefined => {
    if (value === EGRESS_HOST) {
        return "host";
    }
    if (IPV4.safeParse(value).success || CIDRV4.safeParse(value).success) {
        return "v4";
    }
    if (IPV6.safeParse(value).success || CIDRV6.safeParse(value).success) {
        return "v6";
    }
    // A dotted quad that failed as an address (300.1.1.1) is a typo, never a name.
    if (/^[\d./]+$/u.test(value) || value.includes(":")) {
        return undefined;
    }
    return HOSTNAME.test(value) ? "name" : undefined;
};
export const EgressDestinationSchema = z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine((value) => egressDestinationKind(value) !== undefined, {
        message: "A destination is an address (192.168.1.20), a prefix (192.168.1.0/24, fd00::/8), a hostname (nas.lan) or the word host.",
    });

// One port, or an inclusive range spelled `8000-8100`.
export const EgressPortSchema = z.union([
    z.int().min(1).max(65535),
    z
        .string()
        .regex(/^\d{1,5}-\d{1,5}$/u, "A port range is FROM-TO, like 8000-8100.")
        .refine((range) => {
            const from = Number(range.slice(0, range.indexOf("-")));
            const to = Number(range.slice(range.indexOf("-") + 1));
            return from >= 1 && to <= 65535 && from < to;
        }, "A port range runs upwards inside 1-65535, like 8000-8100."),
]);
export type EgressPort = z.infer<typeof EgressPortSchema>;

// One way through `internet-only`. `ports` absent means every port, `protocol` absent means TCP and UDP both. `from`
// names what asked for it (a card's id, `owner`), so a card removed can offer to take its exception with it.
export const EgressAllowSchema = z.strictObject({
    to: EgressDestinationSchema,
    ports: z.array(EgressPortSchema).min(1).max(32).optional(),
    protocol: z.enum(["tcp", "udp"]).optional(),
    note: z.string().max(200).optional(),
    from: z.string().max(200).optional(),
});
export type EgressAllow = z.infer<typeof EgressAllowSchema>;

// A sandbox's policy, WHOLE, as ic stores it in the sandbox's record and as a change carries it. `allow` means
// nothing under `open`, and is kept so turning the fence back on restores the same exceptions.
export const EgressPolicySchema = z.strictObject({
    profile: EgressProfileSchema,
    allow: z.array(EgressAllowSchema).max(64),
});
export type EgressPolicy = z.infer<typeof EgressPolicySchema>;
export const OPEN_EGRESS: EgressPolicy = { profile: "open", allow: [] };

// THE MACHINE'S OWN WORD over every sandbox on it, which a sandbox's policy can only narrow: `/etc/intentic/os.json`'s
// `egress` on Intentic OS, ic's own `~/.intentic/egress.json` elsewhere. `minimum` lifts every sandbox's profile to at
// least itself; `neverAllow` is refused before any sandbox's `allow` is read, so no card can open it.
export const EgressBaselineSchema = z.strictObject({
    minimum: EgressProfileSchema.default("open"),
    neverAllow: z.array(EgressDestinationSchema).max(64).default([]),
});
export type EgressBaseline = z.infer<typeof EgressBaselineSchema>;

// ---- One spelling of a policy, so two policies that fence the same way compare equal ----

// Ports in order of where they start (a range by its first port), duplicates dropped.
const portStart = (port: EgressPort): number => (Number.isInteger(port) ? Number(port) : Number(String(port).slice(0, String(port).indexOf("-"))));
const canonicalPorts = (ports: readonly EgressPort[]): EgressPort[] =>
    [...new Map(ports.map((port) => [String(port), port])).values()].toSorted((a, b) => portStart(a) - portStart(b) || String(a).localeCompare(String(b)));

// One entry with its keys in one order, so JSON.stringify spells it one way.
const canonicalAllow = (entry: EgressAllow): EgressAllow => {
    const out: EgressAllow = { to: entry.to.trim().toLowerCase().replace(/\.$/u, "") };
    if (entry.from !== undefined) {
        out.from = entry.from;
    }
    if (entry.note !== undefined) {
        out.note = entry.note;
    }
    if (entry.ports !== undefined) {
        out.ports = canonicalPorts(entry.ports);
    }
    if (entry.protocol !== undefined) {
        out.protocol = entry.protocol;
    }
    return out;
};
const byText = <T>(items: readonly T[], text: (item: T) => string): T[] =>
    [...new Map(items.map((item) => [text(item), item])).entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);

// The policy in its one form: destinations lower-cased, ports deduplicated and in order, entries deduplicated and in
// order of their text. What `icEgressSetArgs` hands ic, and what the comparisons below read.
export const canonicalEgressPolicy = (policy: EgressPolicy): EgressPolicy => ({
    allow: byText(policy.allow.map(canonicalAllow), (entry) => JSON.stringify(entry)),
    profile: policy.profile,
});
export const canonicalEgressPolicyJson = (policy: EgressPolicy): string => JSON.stringify(canonicalEgressPolicy(policy));

// What an exception OPENS, without its labels: two entries reaching the same place are the same way through.
const reachOf = (entry: EgressAllow): string => JSON.stringify([entry.to, entry.ports ?? null, entry.protocol ?? null]);

// WHETHER A CHANGE ONLY TIGHTENS. Tightening needs no proof from any door; anything else needs the owner's passkey,
// or a door on the machine itself (ic's own CLI, the desktop app). From `open` every policy is tighter. Otherwise the
// new profile must be at least as tight and every way through it opens must already have been open, compared as
// written (not as address arithmetic: a narrower prefix typed differently is asked about, never guessed at).
export const egressOnlyTightens = (from: EgressPolicy, to: EgressPolicy): boolean => {
    if (from.profile === "open") {
        return true;
    }
    if (EGRESS_PROFILE_RANK[to.profile] < EGRESS_PROFILE_RANK[from.profile]) {
        return false;
    }
    const before = new Set(canonicalEgressPolicy(from).allow.map(reachOf));
    return canonicalEgressPolicy(to).allow.every((entry) => before.has(reachOf(entry)));
};

// The revision of the policy ic holds, OPAQUE to everyone but ic: it reports it (EgressStatus.revision), a signed
// change names it back (`basedOn`), and the machine agent compares the two as strings before carrying the change out.
// `none` for a sandbox ic holds no policy for.
export const EGRESS_NO_REVISION = "none";

// ---- The owner's passkey over a loosening ----

// A passkey's public half as the machine agent pins it: the credential id (base64url) and the key as a JWK with its
// COSE algorithm (ES256 -7, RS256 -257, EdDSA -8), the daemon's own stored form.
export const EgressTrustedKeySchema = z.strictObject({
    id: z.string().min(1),
    alg: z.union([z.literal(-7), z.literal(-257), z.literal(-8)]),
    jwk: z.record(z.string(), z.string()),
    // The name the owner gave it in Access → Sign-in, shown wherever the pin is.
    name: z.string().max(200).optional(),
});
export type EgressTrustedKey = z.infer<typeof EgressTrustedKeySchema>;
// The owner's passkeys and where a ceremony with them may run: the editor's rpId, and the exact origins it accepts
// (`https://<rpId>`, its subdomains the daemon admits, the Android app's `android:apk-key-hash:` origins).
// Daemon-filled on every `set-egress`; the machine agent pins it on the first one and only ever replaces it under a
// signature from a key it already pins.
export const EgressOwnerKeysSchema = z.strictObject({
    rpId: z.string().min(1),
    origins: z.array(z.string().min(1)).min(1).max(16),
    keys: z.array(EgressTrustedKeySchema).max(32),
});
export type EgressOwnerKeys = z.infer<typeof EgressOwnerKeysSchema>;
// The owner keys in one spelling (keys by id, each JWK's members in order, origins in order), whose sha256 a signed
// change names as `keys`: the editor hashes what it signs over, the machine agent what the daemon handed it.
export const canonicalEgressOwnerKeysJson = (owner: EgressOwnerKeys): string =>
    JSON.stringify({
        keys: byText(
            owner.keys.map((key) => {
                const out: EgressTrustedKey = {
                    alg: key.alg,
                    id: key.id,
                    jwk: Object.fromEntries(Object.entries(key.jwk).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
                };
                if (key.name !== undefined) {
                    out.name = key.name;
                }
                return out;
            }),
            (key) => key.id,
        ),
        origins: [...new Set(owner.origins)].toSorted(),
        rpId: owner.rpId,
    });

// What the owner's passkey signs to loosen one sandbox's policy on one machine. `basedOn` is the revision it was
// written against, so it can be carried out once and never replayed after any other change; `expiresAt` bounds it
// to minutes; `keys` is the sha256 (hex) of `canonicalEgressOwnerKeysJson` over the owner keys the request carries, so
// the same signature may also move the pin to the owner's current passkeys. The WebAuthn challenge is the sha256 of
// the document's text exactly as `EgressProof.document` carries it; the verifier hashes and parses those same bytes,
// so nothing has to re-spell the document to check it.
export const EgressChangeDocumentSchema = z.strictObject({
    v: z.literal(1),
    purpose: z.literal("intentic-egress-change"),
    machineId: z.string().min(1),
    environment: z.string().min(1),
    slug: z.string().min(1),
    basedOn: z.string().min(1),
    policy: EgressPolicySchema,
    keys: z.string().regex(/^[0-9a-f]{64}$/u),
    expiresAt: z.number().int().positive(),
    nonce: z.string().min(16).max(64),
});
export type EgressChangeDocument = z.infer<typeof EgressChangeDocumentSchema>;
// How long a signed change stays good; the machine agent refuses one whose `expiresAt` is further out than this.
export const EGRESS_PROOF_MAX_AGE_MS = 5 * 60_000;
export const egressChangeDocumentText = (document: EgressChangeDocument): string => JSON.stringify({ ...document, policy: canonicalEgressPolicy(document.policy) });

export const EgressProofSchema = z.strictObject({
    // The document text, byte for byte what the challenge hashed.
    document: z.string().min(1).max(32_768),
    assertion: AuthenticationResponseSchema,
});
export type EgressProof = z.infer<typeof EgressProofSchema>;

// ---- What ic says it holds and enforces ----

// `off`: the policy is open, no rules. `enforced`: the rules are in place for every address the sandbox has.
// `pending`: written, not yet applied (the sandbox is stopped, or ic is between its start and its rules). `failed`:
// ic could not put the rules in; a sandbox with a policy other than open is stopped rather than run unfenced, and
// `reason` says why. `unsupported`: this engine cannot take them (no nftables in its kernel), so the policy is held
// and nothing enforces it.
export const EgressStateSchema = z.enum(["off", "enforced", "pending", "failed", "unsupported"]);
export type EgressState = z.infer<typeof EgressStateSchema>;

// One destination the fence refused, from the per-sandbox counters ic reads back (an nftables dynamic set, an hour of
// memory per entry). `port` is absent for a protocol without ports.
export const EgressBlockedSchema = z.object({
    to: z.string(),
    port: z.number().int().optional(),
    protocol: z.enum(["tcp", "udp", "other"]),
    packets: z.number().int().nonnegative(),
    // When ic first saw this entry's count grow, by the machine's clock (ms); absent when ic has no earlier reading.
    lastSeenAt: z.number().optional(),
});
export type EgressBlocked = z.infer<typeof EgressBlockedSchema>;

export const EgressStatusSchema = z.object({
    // What ic holds for the sandbox, and its revision (EGRESS_NO_REVISION when nothing is held, read as OPEN_EGRESS).
    policy: EgressPolicySchema,
    revision: z.string(),
    // After the machine's baseline: the profile that is enforced and what the baseline refuses whatever `allow` says.
    effectiveProfile: EgressProfileSchema,
    neverAllow: z.array(z.string()),
    state: EgressStateSchema,
    reason: z.string().optional(),
    // `network`: ic's own network for this sandbox, fenced as a whole from the moment it exists. `address`: a network
    // something else made (Compose), fenced per address as docker reports them.
    match: z.enum(["network", "address"]).optional(),
    // The rules are in place but the sandbox can step around them: privileged on runc is the host's root. Under Kata
    // (`isolation: auto`) it is not advisory.
    advisory: z.boolean().optional(),
    // The sandbox may run commands on this very machine through a device grant (`shell`), which reaches past any
    // fence on the machine; the daemon fills this from its own enrollments, ic does not know it.
    hostShell: z.boolean().optional(),
    appliedAt: z.number().optional(),
    // Hostname entries as ic last resolved them on the host.
    resolved: z.array(z.object({ to: z.string(), addresses: z.array(z.string()) })).optional(),
    blocked: z.array(EgressBlockedSchema).max(100),
});
export type EgressStatus = z.infer<typeof EgressStatusSchema>;

// Where ic writes the sandbox's own status inside its container (read-only to nothing: it is a report, and the
// sandbox changing it changes no rule), so the daemon and its agents can say "blocked by the egress policy".
export const EGRESS_STATUS_FILE = "/run/intentic/egress.json";

// ---- ic's verbs, the one spelling outside ic ----

// Sets the whole policy (ic stores it and applies it at once when the sandbox runs, or at its next start).
export const icEgressSetArgs = (slug: string, policy: EgressPolicy): string[] => ["sandbox", "egress", slug, "--policy", canonicalEgressPolicyJson(policy)];
// Prints the sandbox's EgressStatus as JSON.
export const icEgressShowArgs = (slug: string): string[] => ["sandbox", "egress", slug, "--json"];
// Follows docker's events and fences every sandbox start ic did not perform itself; runs until stopped.
export const icEgressFollowArgs = (): string[] => ["sandbox", "egress", "--follow"];

// ---- What the editor reads before it signs (2026-10-27) ----

// `GET /system/egress/owner-keys`: the owner keys the daemon will hand the machine with a `set-egress` sent from this
// same origin, so the editor hashes exactly them into `keys`; the owner's credential ids for the ceremony's
// `allowCredentials`; whether the caller is the owner (only the owner's passkey can sign a loosening); and the
// exceptions this sandbox's own cards suggest. `ownerKeys` is absent when no rpId can be named for the caller's origin.
export const EgressCredentialSchema = z.object({ id: z.string(), transports: z.array(z.string()) });
export const EgressOwnerKeysReadSchema = z.object({
    ownerKeys: EgressOwnerKeysSchema.optional(),
    credentials: z.array(EgressCredentialSchema),
    owner: z.boolean(),
    // This sandbox's own slug: the row on a machine the suggestions are about.
    slug: z.string(),
    suggestions: z.array(EgressAllowSchema),
});
export type EgressOwnerKeysRead = z.infer<typeof EgressOwnerKeysReadSchema>;
