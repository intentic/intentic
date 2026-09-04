import type { Capability, CredentialGate, TurnNote } from "@intentic/sandbox-contract";
import type { CredentialGrants } from "./credential-grants.js";

/* ENFORCEMENT BY ABSENCE, the half of this feature that never raises a card.
 *
 * A stored secret can be gated at the exit it resolves at, because there IS an exit: the model writes a
 * reference, the resolver stops, a person is asked. A CONNECTED ACCOUNT has no such moment. A browser profile
 * is signed in before the turn starts; a connector's token is an environment variable the shell already has;
 * an MCP server is a process already running with its credential inside. By the time the agent "uses" any of
 * them there is nothing left to intercept — the use is a click on an already-authenticated page. So a gated
 * one is simply NOT THERE: its profile is not mounted, its variables are not exported, its server is not
 * started. That is the house pattern already (personas.ts withholds exactly this way, and says why), and this
 * module is the same filter driven by the gate policy instead of by a persona card.
 *
 * WHICH MEANS A NOTE IS OWED, and it is the reason this module also writes prose. Absence is invisible: a turn
 * whose Reddit account was withheld does not see a refusal, it sees a sandbox with no Reddit account, concludes
 * the thing is not connected, and either gives up or goes looking for another road — which is the exact
 * failure `deniedSkills` was written against one door over. The note tells the model the door exists and who
 * opens it, so "I need approval from Bob" is a sentence it can say to the user instead of "Reddit isn't set
 * up".
 *
 * A GRANT MAKES IT PRESENT AGAIN, from the NEXT turn. There is no way to mount a browser profile into a turn
 * that is already running, so `secrets request` is honest about it: the release covers the conversation, and
 * the account arrives when the next turn starts. A `cli` connector is the one exception worth telling the
 * model about, because its credential is also a named secret, so a reference reaches it through the shell
 * exit, which asks per use — a connector can be used inside the very turn that asked for it. */

// The kinds whose credential is a MOUNT rather than a value: signed in, exported or running before the turn
// begins. These are the ones withheld here; a gated secret is stopped at its exit instead.
const MOUNTED_KINDS = new Set<Capability["kind"]>(["browser", "identity", "mcp"]);

export interface GatedCapabilities {
    // The manifest as this turn may see it, gated mounts removed. Mutable like personaCapabilities' own
    // answer, because it stands in the same place: the list every arm's preflight is handed.
    readonly capabilities: Capability[];
    // The gates that did the removing, for the note. One entry per withheld capability, in manifest order.
    readonly withheld: readonly CredentialGate[];
}

// Whether this conversation already holds a release for a subject: the "rest of the conversation" grant, which
// is the only scope a mounted credential can be gated with (the route forces it, and credential-grants.ts
// argues why a session cannot be released for one use).
const released = (grants: CredentialGrants, conversationId: string | undefined, subject: string): boolean =>
    conversationId !== undefined && grants.has(conversationId, subject) !== undefined;

/* Which mounted capabilities this turn does NOT get, applied after the persona's own filter and for the same
 * reason it exists: the arms build browser profiles and MCP servers from the list they are handed, so a
 * capability that is not in it cannot be reached by any road. A conversation that already holds a release
 * keeps its capability, which is what "for the rest of this conversation" means. */
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

/* THE SHELL ENVIRONMENT WITHOUT THE GATED CONNECTORS' CREDENTIALS, the suffix-removal shape personaCliEnv
 * uses, applied to the gate policy's own list.
 *
 * Driven by the DENIED set rather than by a granted allowlist for personaCliEnv's reason, verbatim: this
 * environment carries more than connector credentials (the PATH that makes extension CLIs resolve, an
 * extension's own settings), and filtering to an allowlist would take those with it. */
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

/* THE SKILLS THAT CAME WITH WHAT WE WITHHELD, as the tool names a runtime knows them by, so a gated
 * capability's cheatsheet leaves the turn with its credential.
 *
 * The persona filter already learned this lesson and wrote it down (personas.ts `deniedSkills`): a skill whose
 * tools are not there reads to the model as an OFFER, so it follows the cheatsheet, calls a tool that does not
 * exist, and reports the sandbox as broken. A connector's cheatsheet without its token fails exactly the same
 * way as an account's skill without its browser, which is why both halves of the withholding feed this.
 *
 * The turn NOTE is what replaces them: "this needs Bob, here is how to ask" is the one thing the model should
 * read about a gated credential, and a skill still sitting in its context would be a second, contradictory
 * answer to the same question. */
export const gatedSkills = (withheld: readonly CredentialGate[]): string[] => [
    ...new Set(withheld.map((gate) => `Skill(${gate.subject})`)),
];

export const GATED_CREDENTIALS_TITLE = "Some connected accounts need a person's approval";

/* THE ONE NOTE, over everything withheld from this turn, mount and connector together. One note rather than
 * one per capability, because the model reads notes as a list of conditions and three of them saying the same
 * thing in different words is three chances to act on only the first.
 *
 * It names the CLI door rather than describing the feature, for the reason every note in this sandbox names a
 * command: a model told "this needs approval" says so to the user and stops, and a model told what to run
 * asks. Undefined when nothing was withheld, which is nearly every turn. */
export const gatedCredentialsNote = (withheld: readonly CredentialGate[]): TurnNote | undefined => {
    if (withheld.length === 0) {
        return undefined;
    }
    // One line per subject, deduplicated: a capability can be withheld from the mount list and the environment
    // both (nothing is, today, but the two filters are independent and the note must not say it twice).
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
