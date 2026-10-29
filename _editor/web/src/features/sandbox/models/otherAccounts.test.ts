// What the owner's other sandboxes hold that this one does not: an account already here by any route is left out, the
// same account held twice is one row, and those that can come lead.
import type { ShareableAccount } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import { type HeldHere, offerFor, otherAccounts, otherKey, type SourceRead } from "./otherAccounts";

const LAPTOP = { id: `sbx-laptop`, name: `ada-laptop`, daemonUrl: `https://laptop.example` };
const DESK = { id: `sbx-desk`, name: `ada-desk`, daemonUrl: `https://desk.example` };
const NOTHING_HERE: HeldHere = { borrowed: [], accountsOf: () => [], endpoints: new Set(), subscribed: new Set() };

const read = (source: typeof LAPTOP, accounts: ShareableAccount[]): SourceRead => ({ state: `read`, source, listing: { sandbox: source.name, accounts }, at: 0 });
const CLAUDE: ShareableAccount = { provider: `claude`, account: `acc_max`, label: `Claude Max`, email: `ada@acme.dev`, mode: `lend` };
const ROUTER: ShareableAccount = { provider: `endpoint/openrouter`, label: `openrouter`, mode: `copy` };
const CODEX: ShareableAccount = { provider: `codex`, label: `ChatGPT`, mode: `no`, reason: `Not yet.` };

it(`leaves out an account borrowed from that sandbox, an endpoint or subscription here, and a sign-in to the same person`, () => {
    const reads = [read(LAPTOP, [CLAUDE, ROUTER, CODEX])];
    const borrowedHere: HeldHere = {
        ...NOTHING_HERE,
        borrowed: [{ id: `lent-1`, card: `accounts-ada-laptop`, provider: `claude`, remote: `acc_max`, label: `Claude Max`, from: { name: `ada-laptop`, sandboxId: LAPTOP.id }, borrowedAt: 1 }],
        endpoints: new Set([`endpoint/openrouter`]),
        subscribed: new Set([`codex`]),
    };
    expect(otherAccounts(reads, borrowedHere, new Map())).toEqual([]);
    const signedInHere: HeldHere = { ...NOTHING_HERE, accountsOf: (provider) => (provider === `claude` ? [{ id: `mine`, label: `Mine`, email: `Ada@Acme.dev`, connectedAt: 1 }] : []) };
    expect(otherAccounts(reads, signedInHere, new Map()).map((row) => row.account.provider)).toEqual([`endpoint/openrouter`, `codex`]);
});

it(`keeps a row a press brought in this visit, so it can say what became of it`, () => {
    const signedInHere: HeldHere = { ...NOTHING_HERE, endpoints: new Set([`endpoint/openrouter`]) };
    const outcomes = new Map([[otherKey(LAPTOP.id, ROUTER), { provider: ROUTER.provider, outcome: `copied` as const }]]);
    expect(otherAccounts([read(LAPTOP, [ROUTER])], signedInHere, outcomes)).toHaveLength(1);
});

it(`lists an account two sandboxes hold once, from the one it can come from, and offers a provider's panel the first that can`, () => {
    const lentOn = { ...CLAUDE, account: `lent-1`, mode: `no` as const, reason: `It is borrowed from ada-laptop.` };
    const rows = otherAccounts([read(DESK, [lentOn, CODEX]), read(LAPTOP, [CLAUDE])], NOTHING_HERE, new Map());
    expect(rows.map((row) => [row.source.name, row.account.provider, row.account.mode])).toEqual([
        [`ada-laptop`, `claude`, `lend`],
        [`ada-desk`, `codex`, `no`],
    ]);
    expect(offerFor(rows, `claude`)?.source.name).toBe(`ada-laptop`);
    expect(offerFor(rows, `codex`)).toBeUndefined();
});
