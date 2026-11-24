// WHAT EACH CAPABILITY KIND IS, as one row per kind: every reader that asks "which kinds are signed-in accounts", "which
// mount at a turn's start", "which are peers" reads it off this table, so a new kind is one entry the compiler makes
// complete (`satisfies Record<CapabilityKind, …>`) instead of a dozen hand-kept lists that silently leave it out.
// Pure data with no schema, so the contract lock does not see it.
import type { CapabilityKind } from "../../schemas/capabilities.js";

export interface KindTraits {
    // Which outward group the Sandbox ▸ Map files a connection of this kind under.
    readonly group: "services" | "accounts" | "machines" | "sandboxes" | "network" | "models";
    // A person's credential reach can hold it back (schemas/members.ts `REACHABLE_CREDENTIAL_KINDS`).
    readonly reachable: boolean;
    // Someone signed in: a role reaches it only by naming it (policy/role-capability.ts).
    readonly signedInAccount: boolean;
    // A profile in the sandbox's own browser, signed into by hand in its login window.
    readonly sandboxBrowser: boolean;
    // Its credential is a mount (a profile, an exported token, a running server) a gate can only withhold per turn.
    readonly credentialMount: boolean;
    // Mounted at a turn's start, so a later grant or connection reaches only the next turn.
    readonly turnStartMount: boolean;
    // The peer door its card pairs through, for a computer, a browser or a phone.
    readonly peer?: "hosts" | "webext" | "phones";
    // A tunnel the machine either holds or does not (tunnel/tunnel-links.ts).
    readonly tunnel: boolean;
    // What model provider it mints: an `endpoint/<id>`, or an ACP agent.
    readonly provider?: "endpoint" | "agent";
    // Its id becomes an `mcp__<id>__` server name for the turn (policy/reserved-servers.ts).
    readonly mintsServer: boolean;
    // Where its tile comes from: the built-in catalog, or a card an extension contributes.
    readonly tile: "catalog" | "card";
}

const off = {
    reachable: false,
    signedInAccount: false,
    sandboxBrowser: false,
    credentialMount: false,
    turnStartMount: false,
    tunnel: false,
    mintsServer: false,
} as const;
const account = { ...off, group: "accounts", reachable: true, signedInAccount: true, turnStartMount: true } as const;
const tunnel = { ...off, group: "network", tunnel: true, tile: "catalog" } as const;
const peer = { ...off, group: "machines", reachable: true, turnStartMount: true, tile: "card" } as const;

// In CapabilityKindSchema's own order (a test holds it there).
export const CAPABILITY_KIND_TRAITS = {
    mcp: { ...off, group: "services", reachable: true, credentialMount: true, turnStartMount: true, mintsServer: true, tile: "catalog" },
    cli: { ...off, group: "services", reachable: true, tile: "card" },
    plugin: { ...off, group: "services", reachable: true, turnStartMount: true, tile: "catalog" },
    extension: { ...off, group: "services", reachable: true, tile: "catalog" },
    ssh: { ...off, group: "machines", reachable: true, tile: "catalog" },
    vpn: tunnel,
    exit: tunnel,
    netdisk: tunnel,
    docker: { ...off, group: "machines", tile: "catalog" },
    browser: { ...account, sandboxBrowser: true, credentialMount: true, tile: "card" },
    identity: { ...account, sandboxBrowser: true, credentialMount: true, tile: "catalog" },
    device: { ...peer, peer: "hosts" },
    webext: { ...account, peer: "webext", tile: "card" },
    phone: { ...peer, peer: "phones" },
    agent: { ...off, group: "services", turnStartMount: true, provider: "agent", tile: "card" },
    endpoint: { ...off, group: "models", provider: "endpoint", tile: "catalog" },
    localmodel: { ...off, group: "models", provider: "endpoint", tile: "catalog" },
    wallet: { ...off, group: "services", tile: "catalog" },
    fleet: { ...off, group: "sandboxes", reachable: true, tile: "catalog" },
    link: { ...off, group: "sandboxes", reachable: true, mintsServer: true, tile: "catalog" },
} as const satisfies Record<CapabilityKind, KindTraits>;

type Table = typeof CAPABILITY_KIND_TRAITS;

// The kinds whose row matches `P`, as a type: `KindsWhere<{ tunnel: true }>` is "vpn" | "exit" | "netdisk".
export type KindsWhere<P> = { [K in keyof Table]: Table[K] extends P ? K : never }[keyof Table];

// The kinds a computer, a browser or a phone pairs as.
export type PeerKind = KindsWhere<{ readonly peer: string }>;

// The table's own keys, which `satisfies` holds to exactly the kinds.
// SAFETY: Object.keys of a table that satisfies Record<CapabilityKind, …> lists kinds and nothing else.
const KINDS = Object.keys(CAPABILITY_KIND_TRAITS) as CapabilityKind[];

// The kinds whose row passes `test`, in the enum's order.
export const kindsWhere = (test: (traits: KindTraits) => boolean): readonly CapabilityKind[] =>
    KINDS.filter((kind) => test(CAPABILITY_KIND_TRAITS[kind]));

// The kinds whose row matches `P`, as a list typed by them. `P` and `test` must say the same thing; the contract's test
// pins every list built with this to its literal.
const kindsTyped = <P>(test: (traits: KindTraits) => boolean): readonly KindsWhere<P>[] =>
    // SAFETY: the caller's `test` selects the rows `P` describes, pinned per list in tests/capability-kinds.test.ts.
    kindsWhere(test) as readonly KindsWhere<P>[];

// One kind's row, or undefined for a string no kind answers to (an older or newer peer's kind, an inherited name).
export const traitsOf = (kind: string): KindTraits | undefined => {
    const found = KINDS.find((candidate) => candidate === kind);
    return found === undefined ? undefined : CAPABILITY_KIND_TRAITS[found];
};

// The kinds a computer, a browser or a phone pairs as, and whether a kind (or a mount target's kind) is one.
export const PEER_KINDS = kindsTyped<{ readonly peer: string }>((traits) => traits.peer !== undefined);
export const isPeerKind = (kind: string): kind is PeerKind => traitsOf(kind)?.peer !== undefined;

// The kinds that mint an `endpoint/<id>` model provider, and the kinds that are a profile in the sandbox's own browser,
// typed so `isKindOf` narrows a capability to their configs.
export const ENDPOINT_KINDS = kindsTyped<{ readonly provider: "endpoint" }>((traits) => traits.provider === "endpoint");
export const SANDBOX_BROWSER_KINDS = kindsTyped<{ readonly sandboxBrowser: true }>((traits) => traits.sandboxBrowser);

// Whether a capability is of one of these kinds, narrowing the capability itself (a discriminated union over `kind`).
export const isKindOf = <C extends { readonly kind: string }, K extends string>(
    capability: C,
    kinds: readonly K[],
): capability is Extract<C, { readonly kind: K }> => kinds.some((kind) => kind === capability.kind);
