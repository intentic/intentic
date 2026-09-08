import type { Capability, CredentialGate, TurnNote } from "@intentic/sandbox-contract";
import type { CredentialGrants } from "./credential-grants.js";

// Gates mounted capabilities (browser/identity/mcp) by absence: nothing here can stop a profile already signed in, a
// token exported, or a server running. The note exists because absence alone reads as "not connected". A release only
// takes effect from the next turn; `cli` is the exception, gated per use like a secret.

// Kinds whose credential is a mount (signed in/exported/running before the turn), not a value at an exit.
const MOUNTED_KINDS = new Set<Capability["kind"]>(["browser", "identity", "mcp"]);

export interface GatedCapabilities {
    // The manifest with gated mounts removed; mutable, the list every arm's preflight gets.
    readonly capabilities: Capability[];
    // The gates that did the removing, for the note; one entry per withheld capability, in manifest order.
    readonly withheld: readonly CredentialGate[];
}

// Whether this conversation already holds a release for a subject; the only scope a mounted credential can be gated
// with, since a mount cannot be released for one use.
const released = (grants: CredentialGrants, conversationId: string | undefined, subject: string): boolean =>
    conversationId !== undefined && grants.has(conversationId, subject) !== undefined;

// Removes mounted capabilities this turn does not get: arms build profiles and servers only from this list, so an
// absent capability is unreachable. A conversation already holding a release keeps it.
export const gatedCapabilities = (
    capabilities: readonly Capability[],
    gates: readonly CredentialGate[],
    grants: CredentialGrants,
    conversationId: string | undefined,
): GatedCapabilities => {
    if (gates.length === 0) {
        return { capabilities: [...capabilities], withheld: [] };
    }
    const withheld: CredentialGate[] = [];
    const kept = capabilities.filter((capability) => {
        if (!MOUNTED_KINDS.has(capability.kind)) {
            return true;
        }
        const gate = gates.find((entry) => entry.kind === "capability" && entry.subject === capability.id);
        if (gate === undefined || released(grants, conversationId, capability.id)) {
            return true;
        }
        withheld.push(gate);
        return false;
    });
    return { capabilities: kept, withheld };
};

// The shell environment with gated connectors' variables removed by suffix, mirroring personaCliEnv. Driven by a denied
// set, not an allowlist, since the environment also carries PATH and other settings an allowlist would strip.
export const gatedCliEnv = (
    cliEnv: Record<string, string>,
    capabilities: readonly Capability[],
    gates: readonly CredentialGate[],
    grants: CredentialGrants,
    conversationId: string | undefined,
    envSuffix: (id: string) => string,
): { readonly cliEnv: Record<string, string>; readonly withheld: readonly CredentialGate[] } => {
    if (gates.length === 0) {
        return { cliEnv, withheld: [] };
    }
    const withheld: CredentialGate[] = [];
    const denied: string[] = [];
    for (const capability of capabilities) {
        if (capability.kind !== "cli") {
            continue;
        }
        const gate = gates.find((entry) => entry.kind === "capability" && entry.subject === capability.id);
        if (gate === undefined || released(grants, conversationId, capability.id)) {
            continue;
        }
        withheld.push(gate);
        denied.push(`_${envSuffix(capability.id)}`);
    }
    if (denied.length === 0) {
        return { cliEnv, withheld: [] };
    }
    return {
        cliEnv: Object.fromEntries(Object.entries(cliEnv).filter(([key]) => !denied.some((suffix) => key.endsWith(suffix)))),
        withheld,
    };
};

// Skill names for withheld capabilities, removed alongside their credential: a cheatsheet with no matching tool reads
// to the model as an offer it will follow and fail. The turn note replaces it as the one thing the model should read
// instead.
export const gatedSkills = (withheld: readonly CredentialGate[]): string[] => [
    ...new Set(withheld.map((gate) => `Skill(${gate.subject})`)),
];

export const GATED_CREDENTIALS_TITLE = "Some connected accounts need a person's approval";

// One note over everything withheld, not one per capability, so the model doesn't see one condition three times. Names
// the `secrets request` command instead of describing the feature, so the model asks rather than reports.
export const gatedCredentialsNote = (withheld: readonly CredentialGate[]): TurnNote | undefined => {
    if (withheld.length === 0) {
        return undefined;
    }
    // Deduplicated by subject: the mount and environment filters are independent and could both report one.
    const bySubject = new Map<string, CredentialGate>();
    for (const gate of withheld) {
        bySubject.set(gate.subject, gate);
    }
    const lines = [...bySubject.values()].map(
        (gate) => `- \`${gate.subject}\` needs approval from ${gate.approvers.join(" or ")}: \`secrets request ${gate.subject} --why "…"\``,
    );
    return {
        title: GATED_CREDENTIALS_TITLE,
        text:
            `These are connected and working, but the owner put them behind a named person, so they are not loaded into this turn. ` +
            `They are NOT missing or broken — do not try to connect them again, and do not treat this as the account being unavailable.\n\n` +
            `${lines.join("\n")}\n\n` +
            `Running that raises a card in this chat for the people named; if one of them releases it, the account is loaded from the NEXT turn, ` +
            `so finish this turn and ask the user to continue. A \`cli\` connector is the exception: you can use it right now by writing a ` +
            `\`{{secret:<id>/<field>}}\` reference in a command, which asks for approval for that one use. If nobody releases it, carry on ` +
            `without it and say plainly what you left undone.`,
    };
};
