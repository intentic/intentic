// Pins credential naming inherited from its card, the split between owner-set values and box-only credentials,
// and that this tab never surfaces another page's errand.
import type { ExtensionManifest } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import type { SecretInventoryEntry } from "@intentic/sandbox-contract/schemas/secrets";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { matchesSecret, type SecretSources, secretRow, secretRows } from "./secretRows";

const entry = (over: Partial<SecretInventoryEntry> & Pick<SecretInventoryEntry, `key` | `kind`>): SecretInventoryEntry => ({
    status: `set`,
    requiredBy: [],
    storedAt: `desired-state/.env`,
    revealable: true,
    ...over,
});

const capability = (id: string, kind: string, config: Record<string, string> = {}): CapabilitySummary =>
    ({ id, kind, status: { state: `active` }, config }) as CapabilitySummary;

const extension = (name: string, manifest: Partial<ExtensionManifest>): ExtensionSummary =>
    ({ id: `intentic.${name}`, manifest: { publisher: `intentic`, name, version: `1.0.0`, ...manifest } }) as ExtensionSummary;

const connectors = extension(`connectors`, {
    contributes: {
        capabilities: [{ kind: `browser`, id: `reddit`, catalog: { name: `Reddit`, logo: `reddit`, description: ``, category: `communication` } }],
    } as ExtensionManifest[`contributes`],
});

const sources = (over: Partial<SecretSources> = {}): SecretSources => ({ capabilities: [], extensions: [], ...over });

it(`names a credential after the account, and says which card it came from`, () => {
    const row = secretRow(entry({ key: `reddit-work`, kind: `capability`, status: `connected` }), {
        capabilities: [capability(`reddit-work`, `browser`, { platform: `reddit`, account: `u/work` })],
        extensions: [connectors],
    });
    expect(row.title).toBe(`reddit-work`);
    expect(row.detail).toBe(`Reddit · u/work`);
    expect(row.logo).toBe(`reddit`);
});

it(`does not say the card's name twice when nobody renamed the connection`, () => {
    const row = secretRow(entry({ key: `docker`, kind: `capability`, status: `connected` }), {
        capabilities: [capability(`docker`, `docker`)],
        extensions: [],
    });
    expect(row.title).toBe(`Docker`);
    expect(row.detail).toBe(``);
});

it(`keeps a credential whose connection has gone, rather than dropping it from an inventory`, () => {
    const row = secretRow(entry({ key: `stripe`, kind: `capability`, status: `connected` }), sources());
    expect(row.title).toBe(`stripe`);
    expect(row.group).toBe(`credential`);
});

it(`splits what the owner keeps from what merely lives in the box`, () => {
    const groups = [
        entry({ key: `CF_TOKEN`, kind: `env`, requiredBy: [{ resourceId: `site`, type: `dns` }] }),
        entry({ key: `SPARE`, kind: `env` }),
        entry({ key: `DB_PASSWORD`, kind: `generated` }),
        entry({ key: `claude:acc`, kind: `provider`, label: `Claude · you@example.com`, status: `connected`, revealable: false }),
    ].map((secret) => secretRow(secret, sources()));
    expect(groups.map((row) => row.group)).toEqual([`required`, `yours`, `generated`, `provider`]);
    // Only the owner's own values are removable; generated and provider rows never are.
    expect(groups.map((row) => row.removable)).toEqual([false, true, false, false]);
    expect(groups.map((row) => row.editable)).toEqual([true, true, false, false]);
});

it(`owes attention for a required value nobody set and for a copy CI never got, and for nothing else`, () => {
    const missingRequired = secretRow(
        entry({ key: `CF_TOKEN`, kind: `env`, status: `missing`, requiredBy: [{ resourceId: `s`, type: `d` }] }),
        sources(),
    );
    const missingSpare = secretRow(entry({ key: `SPARE`, kind: `env`, status: `missing` }), sources());
    const stale = secretRow(entry({ key: `DB_PASSWORD`, kind: `generated`, ci: { synced: false } }), sources());
    expect([missingRequired.attention, missingSpare.attention, stale.attention]).toEqual([true, false, true]);
    expect([missingRequired.note, missingSpare.note]).toEqual([`not set`, `not set`]);
    expect(stale.note).not.toBe(missingRequired.note);
});

it(`leaves another page's errand off this tab, while still sorting it to the top of its own group`, () => {
    const rows = secretRows(
        [entry({ key: `reddit-work`, kind: `capability`, status: `connected` }), entry({ key: `github`, kind: `capability`, status: `connected` })],
        {
            capabilities: [
                capability(`github`, `cli`, { provider: `github` }),
                { ...capability(`reddit-work`, `browser`, { platform: `reddit` }), status: { state: `pending` } } as CapabilitySummary,
            ],
            extensions: [connectors],
        },
    );
    expect(rows.map((row) => row.attention)).toEqual([false, false]);
    const [top, below] = [rows[0]?.state, rows[1]?.state];
    // Shape read by hand, not through an asymmetric matcher: bun writes the matchers it satisfied into the received
    // object, and the rank below is read off that same state.
    expect([typeof top?.label, typeof top?.tone, typeof top?.rank]).toEqual([`string`, `string`, `number`]);
    expect(top?.label).not.toBe(below?.label);
    expect(top!.rank).toBeLessThan(below!.rank);
});

it(`finds a credential by the things its row actually shows`, () => {
    const row = secretRow(entry({ key: `reddit-work`, kind: `capability`, status: `connected` }), {
        capabilities: [capability(`reddit-work`, `browser`, { platform: `reddit`, account: `u/work` })],
        extensions: [connectors],
    });
    // Matches on the brand and handle, neither of which appears in the stored key.
    expect(matchesSecret(row, `reddit`, false)).toBe(true);
    expect(matchesSecret(row, `u/work`, false)).toBe(true);
    // A credential's status is never `missing`; the Missing scope should exclude it.
    expect(matchesSecret(row, ``, true)).toBe(false);
});

it(`searches an env secret by what uses it, not only by its key`, () => {
    const row = secretRow(entry({ key: `CF_TOKEN`, kind: `env`, requiredBy: [{ resourceId: `shop-dns`, type: `dns` }] }), sources());
    expect(matchesSecret(row, `shop-dns`, false)).toBe(true);
});

it(`says who has to approve a gated row, and does not count it as an errand`, () => {
    const gated = secretRow(entry({ key: `DATABASE_URL`, kind: `env`, gate: { approvers: [`bob@corp.com`], scope: `use` } }), sources());
    expect(gated.note).toBe(`needs approval from bob@corp.com`);
    expect(gated.attention).toBe(false);
    // Multiple approvers join with "or": either can release it.
    const shared = secretRow(
        entry({ key: `DATABASE_URL`, kind: `env`, gate: { approvers: [`bob@corp.com`, `alice@corp.com`], scope: `conversation` } }),
        sources(),
    );
    expect(shared.note).toBe(`needs approval from bob@corp.com or alice@corp.com`);
});

it(`lets a real debt outrank the gate note on one row`, () => {
    const missing = secretRow(
        entry({
            key: `CF_TOKEN`,
            kind: `env`,
            status: `missing`,
            requiredBy: [{ resourceId: `s`, type: `d` }],
            gate: { approvers: [`bob@corp.com`], scope: `use` },
        }),
        sources(),
    );
    expect(missing.note).toBe(`not set`);
});

it(`finds a gated row by the word people type and by the approver's address`, () => {
    const gated = secretRow(entry({ key: `DATABASE_URL`, kind: `env`, gate: { approvers: [`bob@corp.com`], scope: `use` } }), sources());
    expect(matchesSecret(gated, `approval`, false)).toBe(true);
    expect(matchesSecret(gated, `bob@corp.com`, false)).toBe(true);
    const open = secretRow(entry({ key: `OTHER`, kind: `env` }), sources());
    expect(matchesSecret(open, `approval`, false)).toBe(false);
});

it(`offers a gate only where there is something to release, and forces conversation scope on a mounted account`, () => {
    // Nothing to release: an unset value, or an AI subscription (would gate every turn).
    expect(secretRow(entry({ key: `SPARE`, kind: `env`, status: `missing` }), sources()).gateSubject).toBeUndefined();
    expect(secretRow(entry({ key: `claude:default`, kind: `provider`, revealable: false }), sources()).gateSubject).toBeUndefined();
    // A stored value is released one use at a time.
    const stored = secretRow(entry({ key: `DATABASE_URL`, kind: `env` }), sources());
    expect([stored.gateSubject, stored.sessionShaped]).toEqual([`DATABASE_URL`, false]);
    // A signed-in browser is mounted for the whole turn; the daemon forces conversation scope
    // (secrets/credential-grants.ts).
    const browser = secretRows([entry({ key: `reddit`, kind: `capability`, status: `connected` })], {
        capabilities: [capability(`reddit`, `browser`, { platform: `reddit` })],
        extensions: [connectors],
    })[0];
    expect([browser?.gateSubject, browser?.sessionShaped]).toEqual([`reddit`, true]);
    // A connector credential is spent at an exit, like a stored secret, so scope stays a choice.
    const connector = secretRows([entry({ key: `github`, kind: `capability`, status: `connected` })], {
        capabilities: [capability(`github`, `cli`, { provider: `github` })],
        extensions: [connectors],
    })[0];
    expect([connector?.gateSubject, connector?.sessionShaped]).toEqual([`github`, false]);
});

// A pointer to a keyring entry on one of the owner's computers: its own group, named by the computer and the share, never
// editable or removable here, and said to be unusable only where its share makes that true.
const kept = (device: NonNullable<SecretInventoryEntry[`device`]>, over: Partial<SecretInventoryEntry> = {}): SecretInventoryEntry =>
    entry({ key: `VPN_PASSWORD`, kind: `device`, storedAt: `the keyring on rog`, revealable: false, device, ...over });

it(`puts a secret kept on one of the owner's computers in a group of its own, named by the computer and its share`, () => {
    const row = secretRow(kept({ machine: `rog`, mode: `each-use`, online: true, locked: false, source: `keyring` }), sources());
    expect(row.group).toBe(`device`);
    expect(row.detail).toBe(`rog · asks each time`);
    expect([row.editable, row.removable, row.programsHere]).toEqual([false, false, false]);
    // The sandbox's own named approver still runs first, and the owner can still type it into a window.
    expect([row.gateSubject, row.typeable]).toEqual([`VPN_PASSWORD`, true]);
    expect(row.attention).toBe(false);
    expect(matchesSecret(row, `rog`, false)).toBe(true);
});

it(`says a kept secret cannot be used only where its share makes that true`, () => {
    const offline = secretRow(kept({ machine: `rog`, mode: `while-here`, online: false, source: `keyring` }), sources());
    expect(offline.state?.label).toBe(`Offline`);
    expect(offline.note).toBe(`rog is offline: this cannot be used until it answers`);
    const locked = secretRow(kept({ machine: `rog`, mode: `while-here`, online: true, locked: true, source: `keyring` }), sources());
    expect([locked.state?.label, locked.note]).toEqual([`Locked`, `rog is locked: each use asks there`]);
    // Asking each time asks whether locked or not; a copy lives here and works with the computer off.
    const eachUse = secretRow(kept({ machine: `rog`, mode: `each-use`, online: true, locked: true, source: `keyring` }), sources());
    expect(eachUse.note).toBeUndefined();
    const copy = secretRow(kept({ machine: `rog`, mode: `copy`, online: false, source: `keyring` }), sources());
    expect([copy.state, copy.note, copy.detail]).toEqual([undefined, undefined, `rog · copy kept here`]);
    // Sorted with what needs a look first, inside its group.
    const rows = secretRows([kept({ machine: `rog`, mode: `copy`, online: true, source: `keyring` }, { key: `A_FIRST` }), kept({ machine: `rog`, mode: `while-here`, online: false, source: `keyring` }, { key: `Z_LAST` })], sources());
    expect(rows.map((one) => one.entry.key)).toEqual([`Z_LAST`, `A_FIRST`]);
});

it(`offers Type into… and a program list only for a value stored under a name the route takes`, () => {
    const stored = secretRow(entry({ key: `DATABASE_URL`, kind: `env` }), sources());
    expect([stored.typeable, stored.programsHere]).toEqual([true, true]);
    const generated = secretRow(entry({ key: `SESSION_KEY`, kind: `generated` }), sources());
    expect(generated.typeable).toBe(true);
    // Nothing to type yet, a model account's credential, a connection's: none of them.
    expect(secretRow(entry({ key: `SPARE`, kind: `env`, status: `missing` }), sources()).typeable).toBe(false);
    expect(secretRow(entry({ key: `claude:acc`, kind: `provider`, revealable: false }), sources()).typeable).toBe(false);
    expect(secretRow(entry({ key: `github`, kind: `capability`, status: `connected` }), sources()).typeable).toBe(false);
    // A keyring name may carry a dot, which the Type into… route's name rule refuses.
    expect(secretRow(kept({ machine: `rog`, mode: `each-use`, online: true, source: `keyring` }, { key: `vpn.password` }), sources()).typeable).toBe(false);
});
