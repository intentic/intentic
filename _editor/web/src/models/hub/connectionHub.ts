import {
    HUB_ACCOUNT_PROVIDERS,
    type HubAccountProvider,
    type HubHolding,
    type HubState,
    type HubTarget,
    type HubWant,
    hubSlug,
    sameHubTarget,
} from "@intentic/sandbox-contract/schemas/connection-hub";
import { t } from "@intentic/ui/i18n";

// THE CONNECTIONS HUB as the editor offers it (schemas/connection-hub.ts in the contract): the keyring on one of the
// owner's computers keeps a connection saved from one sandbox, and any other sandbox of theirs takes it from there. These
// are the judgements a connection's row and an add form share: which computers can take one in, what a row says of its
// connection's place in the hub, and what a tile or a provider asks the computer for.

/**
 * The computers a connection can be saved to now: connected, with Passwords set up there. A locked one still takes it,
 * and holds it until its next unlock, so locked is no reason to leave it out.
 */
export const readyComputers = (state: HubState | undefined): readonly string[] =>
    (state?.computers ?? []).filter((computer) => computer.online && computer.setUp).map((computer) => computer.machine);

/** What the hub knows of one card or account held here, if it is of a kind the hub carries at all. */
export const holdingOf = (state: HubState | undefined, target: HubTarget): HubHolding | undefined =>
    state?.holdings.find((holding) => sameHubTarget(holding.target, target));

/** The computers a held connection can be saved to: none when it cannot travel (it has a `reason`), or none can take it. */
export const saveTargets = (holding: HubHolding | undefined, ready: readonly string[]): readonly string[] =>
    holding?.want === undefined ? [] : ready;

/**
 * What a row says of its connection's place in the hub, quietly, beside its name. A save still waiting on the person at
 * the computer comes first, since it is the one thing left to do; then where a connection made from the hub came from,
 * since it goes when that computer stops sharing it; then where this one was saved.
 */
export const hubNote = (holding: HubHolding | undefined): string | undefined => {
    if (holding?.saved?.pending === true) {
        return t(`sandbox.connectionHub.waitsForYes`, { machine: holding.saved.machine });
    }
    if (holding?.from !== undefined) {
        return holding.from.machine === undefined
            ? t(`sandbox.connectionHub.fromComputer`)
            : t(`sandbox.connectionHub.fromComputerNamed`, { machine: holding.from.machine });
    }
    return holding?.saved === undefined ? undefined : t(`sandbox.connectionHub.savedTo`, { machine: holding.saved.machine });
};

/** What a connection's row shows of the hub: the computers it can be saved to, what it says, and whether a save is on its way. */
export interface HubRowView {
    readonly saveTo: readonly string[];
    readonly note: string | undefined;
    readonly busy: boolean;
}

/** How a save's press is labelled: the one computer by name, or the question of which when there are several. */
export const saveLabel = (machines: readonly string[]): string =>
    machines.length === 1 ? t(`sandbox.connectionHub.saveTo`, { machine: machines[0] }) : t(`sandbox.connectionHub.saveToComputer`);

/**
 * What a catalog tile asks the computer for: a CLI connector's own card (unless the connector renews its sign-in, which
 * never travels, so nothing could be saved to answer it), or any tool server or model endpoint. Every other kind is
 * tied to where it was made.
 */
export const tileWant = (kind: string, id: string, renews: boolean): HubWant | undefined => {
    if (kind === `cli`) {
        return renews ? undefined : { type: `card`, kind: `cli`, connector: hubSlug(id) };
    }
    return kind === `mcp` || kind === `endpoint` ? { type: `card`, kind } : undefined;
};

const isHubAccountProvider = (provider: string): provider is HubAccountProvider => HUB_ACCOUNT_PROVIDERS.some((known) => known === provider);

/** What a model provider's panel asks the computer for: its account, where that is a key that does not rotate. */
export const accountWant = (provider: string): HubWant | undefined => (isHubAccountProvider(provider) ? { type: `account`, provider } : undefined);

/** One account of a provider's, as the hub names it, where the provider's accounts travel at all. */
export const accountTarget = (provider: string, id: string): HubTarget | undefined =>
    isHubAccountProvider(provider) ? { type: `account`, provider, id } : undefined;

/** A save's key in the operations ledger: one per card or account, so two rows' saves never answer for each other. */
export const targetKey = (target: HubTarget): string => (target.type === `card` ? `card/${target.id}` : `account/${target.provider}/${target.id}`);

/** A take's key in the operations ledger: one per thing asked for, so a tile and a panel each read only their own answer. */
export const wantKey = (want: HubWant): string => (want.type === `account` ? `account/${want.provider}` : `card/${want.kind}/${want.connector ?? ``}`);
