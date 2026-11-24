import { sandboxRef } from "@intentic/extension-api";
import { loopLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { localFace } from "../../../app/environments/local";
import { advertisedLoops, type AdvertisedLoops } from "../offeredLoops";
import { providerAccounts } from "../providerAccounts";
import { acpProviders, nativeReady } from "../providerCatalog";

/* THE CODING AGENTS OF THIS COMPUTER, for a chat that runs outside every sandbox (local/agents/). There a provider is a
   harness the reader has installed, or could have: `providers.list` names every one this computer runs or could be set
   up to run (`loops`), and of those the ones that run now (`native`, `agents`). Its one account is the harness's own
   stored sign-in, which the list of accounts states and never proves: a sign-in gone stale is only found by the turn it
   refuses. So what a harness needs before it can run is judged here from all three, and from nothing a sandbox knows. */

/** What stands between a harness and a turn: nothing, its own sign-in, or being fetched onto this computer first. */
export type HarnessStanding = `ready` | `signIn` | `setUp`;

export interface ComputerHarness {
    readonly id: AgentProvider;
    /** The program's own name (Claude Code, Codex), never a model vendor's. */
    readonly label: string;
    readonly standing: HarnessStanding;
    /** Its stored sign-in as the harness states it, where it states one. */
    readonly account: OauthAccount | undefined;
    /**
     * Whether the account and model routes answer for it. They take a provider the contract names, so a program it does
     * not (OpenCode) is listed and run, and keeps its sign-in and its model to itself.
     */
    readonly asked: boolean;
}

export interface HarnessFacts {
    readonly loops: AdvertisedLoops;
    readonly native: readonly string[];
    readonly agents: readonly { readonly id: string; readonly label: string }[];
    readonly accounts: Readonly<Record<string, readonly OauthAccount[] | undefined>>;
    /** Harnesses whose account list has been read: an empty list means signed out only once it has been. */
    readonly read: ReadonlySet<string>;
    /** Harnesses whose last turn was refused for want of a sign-in, whatever their account list says. */
    readonly refused: ReadonlySet<string>;
}

// Names the listing does not carry and the contract spells for a sandbox (its "Google" is a sign-in, not a program).
const OWN_NAMES = new Map([
    [`gemini`, `Gemini CLI`],
    [`opencode`, `OpenCode`],
]);

const labelOf = (id: string, facts: HarnessFacts): string => facts.agents.find((agent) => agent.id === id)?.label ?? OWN_NAMES.get(id) ?? loopLabel(id, `vendor`);

export const standingOf = (id: string, facts: HarnessFacts): HarnessStanding => {
    if (!facts.native.includes(id) && !facts.agents.some((agent) => agent.id === id)) {
        return `setUp`;
    }
    const accounts = facts.accounts[id] ?? [];
    const signedOut = facts.read.has(id) && accounts.length === 0;
    return signedOut || facts.refused.has(id) || accounts.some((account) => account.needsReauth === true) ? `signIn` : `ready`;
};

/** Every harness the listing names, the ones that can run now first, each in the listing's own order. */
export const harnessesFrom = (facts: HarnessFacts): ComputerHarness[] => {
    const ids = [...new Set([...facts.native, ...facts.agents.map((agent) => agent.id), ...Object.keys(facts.loops ?? {})])];
    const all = ids.map((id) => ({
        id,
        label: labelOf(id, facts),
        standing: standingOf(id, facts),
        account: facts.accounts[id]?.[0],
        asked: NATIVE_PROVIDERS.some((provider) => provider === id),
    }));
    return [...all.filter((harness) => harness.standing !== `setUp`), ...all.filter((harness) => harness.standing === `setUp`)];
};

// Which account lists this window has read, and which harnesses a turn found signed out. Both go with the folder.
const harnessAccountsRead = sandboxRef<ReadonlySet<string>>(() => new Set());
const harnessesRefused = sandboxRef<ReadonlySet<string>>(() => new Set());

/** A turn on this harness was refused for want of a sign-in, or (false) its sign-in has just landed. */
export const noteHarnessRefused = (id: AgentProvider, refused: boolean): void => {
    const next = new Set(harnessesRefused.value);
    if (refused) {
        next.add(id);
    } else {
        next.delete(id);
    }
    harnessesRefused.value = next;
};

export const noteHarnessAccountsRead = (id: AgentProvider): void => {
    harnessAccountsRead.value = new Set([...harnessAccountsRead.value, id]);
};

export const computerHarnesses = computed(() =>
    harnessesFrom({
        loops: advertisedLoops.value,
        native: nativeReady.value,
        agents: acpProviders.value,
        accounts: providerAccounts.value,
        read: harnessAccountsRead.value,
        refused: harnessesRefused.value,
    }),
);

export const computerHarness = (id: AgentProvider): ComputerHarness | undefined => computerHarnesses.value.find((harness) => harness.id === id);

/**
 * A turn refused for want of a sign-in, where the chat runs on this computer: remembered, so the press that signs the
 * harness in is offered whatever its account list says, and answered with the line the chat shows. Undefined in a sandbox.
 */
export const harnessRefusedTurn = (id: AgentProvider): string | undefined => {
    if (localFace() === undefined) {
        return undefined;
    }
    noteHarnessRefused(id, true);
    return t(`chat.computer.harness.refusedTurn`, { harness: computerHarness(id)?.label ?? id });
};
