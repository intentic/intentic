import { refuse } from "@intentic/contract-serve";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    HUB_ACCOUNT_PROVIDERS,
    HUB_ENTRY_PREFIX,
    type HubComputer,
    type HubHolding,
    type HubTarget,
    type HubWant,
    hubSlug,
} from "@intentic/sandbox-contract/schemas/connection-hub";
import type { Doors } from "../doors";
import { capabilityList, fileCapability } from "./capabilities";
import { fileNativeAccount, nativeAccounts } from "./signIns";

// THE CONNECTIONS HUB (connection-hub.ts in the contract) as the shop's sandbox answers it: the keyring on rog, Ada's
// workstation (unlocked, as the Passwords view shows it), keeps connections for her other sandboxes; omen, the laptop, is
// off. The cards and keys here that do not renew a sign-in can be saved there (GitHub's card, the Cursor key), and Sentry's
// card was made here from an entry rog shares. Asked for one, rog has a PostHog card and a Z.ai key saved from the laptop's
// sandbox, which come in at once, and a model endpoint, which waits for Ada's yes at rog before it does.

const COMPUTERS: readonly HubComputer[] = [
    { machine: `rog`, online: true, setUp: true, locked: false },
    { machine: `omen`, online: false, setUp: true, locked: true },
];

// How long the computer takes to answer a save, and the person at it to say yes to a take that waits for them.
const ANSWER_MS = 900;
const YES_AFTER_MS = 6_000;

// Connectors whose card renews its own sign-in, so it stays where it was made.
const RENEWS: ReadonlySet<string> = new Set([`google-workspace`, `microsoft-365`, `imap`]);
const ROTATES = `It is a sign-in this sandbox renews, so another sandbox would sign it out: sign in there instead.`;

const keyOf = (target: HubTarget): string => (target.type === `card` ? `card:${target.id}` : `account:${target.provider}:${target.id}`);

interface Saved {
    readonly entry: string;
    readonly machine: string;
    readonly at: number;
    readonly pending: boolean;
}
const saved = new Map<string, Saved>();
// What was made here from an entry rog shares, by what it was made into.
const made = new Map<string, { readonly entry: string; readonly machine: string }>([[`card:sentry`, { entry: `CONNECTION_SENTRY_4C1D`, machine: `rog` }]]);

let entries = 0;
const entryFor = (want: HubWant): string => {
    entries += 1;
    const what = want.type === `account` ? want.provider : (want.connector ?? want.kind);
    return `${HUB_ENTRY_PREFIX}${what.toUpperCase().replace(/[^A-Z0-9]+/gu, `_`)}_${(0x7f3a + entries).toString(16).toUpperCase()}`;
};

const holding = (target: HubTarget, label: string, want: HubWant, reason: string | undefined): HubHolding => {
    const row: HubHolding = reason === undefined ? { target, label, want } : { target, label, reason };
    const kept = saved.get(keyOf(target));
    if (kept !== undefined) {
        row.saved = kept;
    }
    const from = made.get(keyOf(target));
    if (from !== undefined) {
        row.from = from;
    }
    return row;
};

// Every card and static account held here of a kind the hub carries, and whether each can go: the rule hub-items.ts holds.
const holdings = (): HubHolding[] => {
    const cards = capabilityList().capabilities.flatMap((card) => {
        const target: HubTarget = { type: `card`, id: card.id };
        if (card.kind === `cli`) {
            const connector = String(card.config[`provider`] ?? card.id);
            return [holding(target, card.id, { type: `card`, kind: `cli`, connector: hubSlug(connector) }, RENEWS.has(connector) ? ROTATES : undefined)];
        }
        if (card.kind === `mcp` || card.kind === `endpoint`) {
            return [holding(target, card.id, { type: `card`, kind: card.kind }, card.config[`signedIn`] === true ? ROTATES : undefined)];
        }
        return [];
    });
    const accounts = HUB_ACCOUNT_PROVIDERS.flatMap((provider) =>
        nativeAccounts(provider).map((account) =>
            holding({ type: `account`, provider, id: account.id }, account.label, { type: `account`, provider }, account.needsReauth === true ? `It needs signing in again here first.` : undefined),
        ),
    );
    return [...cards, ...accounts];
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// What rog holds that this sandbox could ask for, and what each is made into here.
const POSTHOG: Capability = { id: `posthog`, kind: `cli`, config: { provider: `posthog`, host: `https://eu.posthog.com`, token: `phx_demo_from_rog` } };
const ENDPOINT: Capability = { id: `together`, kind: `endpoint`, config: { baseUrl: `https://api.together.xyz/v1`, protocol: `openai`, apiKey: `tgp_v1_demo_from_rog_0f3c` } };

const makeCard = (card: Capability, entry: string): HubTarget => {
    fileCapability(card);
    made.set(`card:${card.id}`, { entry, machine: `rog` });
    return { type: `card`, id: card.id };
};

const takeOne = (want: HubWant) => {
    if (want.type === `account` && want.provider === `zai`) {
        const id = `zai_rog`;
        fileNativeAccount(`zai`, { id, label: `GLM Coding Plan`, email: `ada@lovelace.dev`, connectedAt: Date.now(), connectedBy: `ada@acme.dev` });
        made.set(`account:zai:${id}`, { entry: `CONNECTION_ZAI_19B2`, machine: `rog` });
        return { outcome: `taken` as const, message: `Shared from rog.`, target: { type: `account` as const, provider: `zai` as const, id } };
    }
    if (want.type === `card` && want.kind === `cli` && want.connector === `posthog`) {
        return { outcome: `taken` as const, message: `Shared from rog.`, target: makeCard(POSTHOG, `CONNECTION_POSTHOG_A7E0`) };
    }
    if (want.type === `card` && want.kind === `endpoint`) {
        setTimeout(() => makeCard(ENDPOINT, `CONNECTION_ENDPOINT_3D58`), YES_AFTER_MS);
        return { outcome: `waiting` as const, message: `Waiting for your yes in Passwords on rog.` };
    }
    return { outcome: `none` as const, message: `Nothing saved on rog answers this. Save one there from the sandbox that has it.` };
};

export const hubDoors = {
    state: () => ({ computers: [...COMPUTERS], holdings: holdings(), failures: [] }),
    save: async ({ target, machine }) => {
        const computer = COMPUTERS.find((candidate) => candidate.machine === machine);
        if (computer === undefined || !computer.online) {
            return refuse(`${machine} is not connected right now, so its keyring cannot take this connection.`, 409);
        }
        const held = holdings().find((candidate) => keyOf(candidate.target) === keyOf(target));
        if (held?.want === undefined) {
            return refuse(held?.reason ?? `There is no connection here that the hub can keep.`, 409);
        }
        await wait(ANSWER_MS);
        const key = keyOf(target);
        const entry = saved.get(key)?.entry ?? made.get(key)?.entry ?? entryFor(held.want);
        const kept: Saved = { entry, machine, at: Date.now(), pending: computer.locked === true };
        saved.set(key, kept);
        return { entry, machine, pending: kept.pending };
    },
    take: async ({ want }) => {
        await wait(ANSWER_MS);
        return takeOne(want);
    },
} satisfies Doors<`hub`>;
