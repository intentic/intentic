// WHETHER A PERSONA LETS A TURN ACT THROUGH ONE CONNECTED CAPABILITY. Pure and shared, because the daemon mounts a turn's
// tools on this answer (personas/personas.ts `turnPersona`) and the Sandbox ▸ Map view draws who reaches what from it,
// and two implementations would disagree at exactly the boundary that matters.

// The two fields of a connection the rule reads; structural, so neither side has to hand over its own record type.
export interface CapabilityRef {
    readonly id: string;
    readonly kind: string;
}

// The persona's shelves the rule reads, fully resolved (PersonaPowersSchema's defaults applied): a list absent means
// every connection of its kind, an empty one none.
export interface PersonaShelves {
    readonly sandbox: boolean;
    readonly delegate: boolean;
    readonly connectors?: readonly string[] | undefined;
    readonly devices?: readonly string[] | undefined;
    readonly mcp?: readonly string[] | undefined;
}

/**
 * The kinds that are someone signed in: a site account, the identity whose browser holds every account born of it, and
 * the owner's own browser (its extension), which holds every session they have. The last one was missing until
 * 2026-10-25, and it fell through to "passes untouched": an X-only persona's unattended run reached the owner's Brave,
 * and an unpinned wake that lost every sandbox account kept it.
 */
export const isSignedInAccount = (kind: string): boolean => kind === "browser" || kind === "identity" || kind === "webext";

const listed = (list: readonly string[] | undefined, id: string): boolean => list === undefined || list.includes(id);

/**
 * Whether a persona carrying these accounts (its `capabilities`) and these shelves may act through a capability. A kind
 * absent from the switch (an agent runtime, a devops entry, a VPN) passes untouched, so a new kind is never silently
 * denied.
 */
export const personaAllowsCapability = (capability: CapabilityRef, accounts: readonly string[], shelves: PersonaShelves): boolean => {
    switch (capability.kind) {
        // The signed-in browsers: the persona's own `capabilities` list, and the field that predates the shelves. Granting
        // an account (`reddit-work`) grants its hands; granting the identity itself grants the someone. The owner's own
        // browser is named the same way: a persona reaches it only when its list says so.
        case "browser":
        case "identity":
        case "webext":
            return accounts.includes(capability.id);
        // Connector credentials reach the shell; an ungranted id keeps its env vars out of the turn entirely.
        case "cli":
            return listed(shelves.connectors, capability.id);
        // A phone is one of the owner's own devices, on the same shelf as their computers.
        case "device":
        case "phone":
            return listed(shelves.devices, capability.id);
        case "mcp":
            return listed(shelves.mcp, capability.id);
        // Making sandboxes on the owner's account is administering what this one runs beside: the sandbox shelf.
        case "fleet":
            return shelves.sandbox;
        // Another of the owner's sandboxes sits on the devices list beside their computers, picked one by one, and handing
        // it a task is delegating, as spawning a subagent is.
        case "link":
            return shelves.delegate && listed(shelves.devices, capability.id);
        default:
            return true;
    }
};
