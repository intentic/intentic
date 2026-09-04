// WHAT THE TAB LOOKED LIKE BEFORE: nineteen rows reading `radarsuspam2, radarsuspam3, …` down a column, each
// with the same four buttons on it, none of them sayable apart and none of them settable here. What is pinned
// here is the two things that fixed it: a credential wearing the name and brand of the card it came from, and
// the line between a value the owner keeps and one that merely lives in the box: plus the rule that keeps this
// tab from shouting about another page's errand.
import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { ExtensionManifest } from "@intentic/extension-manifest";
import type { ExtensionSummary, SecretInventoryEntry } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
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
    // `docker` written under a Docker logo with "Docker" beside it is the same word three times.
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
    // Only the owner's own may be taken away here; nothing on this tab adds a generated value or a subscription.
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
    // Both say they are empty; only one of them is an outstanding task.
    expect([missingRequired.note, missingSpare.note]).toEqual([`not set`, `not set`]);
    // A copy CI never got is not the same errand as a value nobody set, and its row must not borrow that wording.
    expect(stale.note).not.toBe(missingRequired.note);
});

it(`leaves another page's errand off this tab, while still sorting it to the top of its own group`, () => {
    // A browser account whose session expired is a real problem, and one only the Capabilities page can fix.
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
    // The errand still carries a whole connection state, and still outranks the row that merely works.
    expect(rows[0]?.state).toMatchObject({ label: expect.any(String), tone: expect.any(String), rank: expect.any(Number) });
    expect(rows[0]?.state?.label).not.toBe(rows[1]?.state?.label);
    expect(rows[0]!.state!.rank).toBeLessThan(rows[1]!.state!.rank);
});

it(`finds a credential by the things its row actually shows`, () => {
    const row = secretRow(entry({ key: `reddit-work`, kind: `capability`, status: `connected` }), {
        capabilities: [capability(`reddit-work`, `browser`, { platform: `reddit`, account: `u/work` })],
        extensions: [connectors],
    });
    // The brand and the handle, neither of which is anywhere in the key the daemon stored it under.
    expect(matchesSecret(row, `reddit`, false)).toBe(true);
    expect(matchesSecret(row, `u/work`, false)).toBe(true);
    // A credential can never be missing, so the Missing scope must not leave it standing there.
    expect(matchesSecret(row, ``, true)).toBe(false);
});

it(`searches an env secret by what uses it, not only by its key`, () => {
    const row = secretRow(entry({ key: `CF_TOKEN`, kind: `env`, requiredBy: [{ resourceId: `shop-dns`, type: `dns` }] }), sources());
    expect(matchesSecret(row, `shop-dns`, false)).toBe(true);
});

/* THE APPROVAL GATE, as a row reads it. A gate is the configuration WORKING, not an errand, so what is pinned
 * here is that it says who is waiting without borrowing the tab's one warning colour. */

it(`says who has to approve a gated row, and does not count it as an errand`, () => {
    const gated = secretRow(entry({ key: `DATABASE_URL`, kind: `env`, gate: { approvers: [`bob@corp.com`], scope: `use` } }), sources());
    expect(gated.note).toBe(`needs approval from bob@corp.com`);
    // "Bob has to release this" is the owner's own configuration, not something anybody has to go and fix.
    expect(gated.attention).toBe(false);
    // Two approvers read as a choice, because either of them can release it.
    const shared = secretRow(
        entry({ key: `DATABASE_URL`, kind: `env`, gate: { approvers: [`bob@corp.com`, `alice@corp.com`], scope: `conversation` } }),
        sources(),
    );
    expect(shared.note).toBe(`needs approval from bob@corp.com or alice@corp.com`);
});

it(`lets a real debt outrank the gate note on one row`, () => {
    // A value nobody has set is the louder fact, and it is the one a reader is scanning for.
    const missing = secretRow(
        entry({ key: `CF_TOKEN`, kind: `env`, status: `missing`, requiredBy: [{ resourceId: `s`, type: `d` }], gate: { approvers: [`bob@corp.com`], scope: `use` } }),
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
    // Nothing to release: a value nobody has set, and an AI subscription (gating THAT would stop every turn).
    expect(secretRow(entry({ key: `SPARE`, kind: `env`, status: `missing` }), sources()).gateSubject).toBeUndefined();
    expect(secretRow(entry({ key: `claude:default`, kind: `provider`, revealable: false }), sources()).gateSubject).toBeUndefined();
    // A stored value is spent at an exit, so it can be released one use at a time.
    const stored = secretRow(entry({ key: `DATABASE_URL`, kind: `env` }), sources());
    expect([stored.gateSubject, stored.sessionShaped]).toEqual([`DATABASE_URL`, false]);
    /* A signed-in browser is MOUNTED for a whole turn, so there is no single use to release: the row says so
     * and the daemon forces the scope (secrets/credential-grants.ts). */
    const browser = secretRows([entry({ key: `reddit`, kind: `capability`, status: `connected` })], {
        capabilities: [capability(`reddit`, `browser`, { platform: `reddit` })],
        extensions: [connectors],
    })[0];
    expect([browser?.gateSubject, browser?.sessionShaped]).toEqual([`reddit`, true]);
    // A connector's credential is a value at an exit, like a stored secret, so it keeps the choice.
    const connector = secretRows([entry({ key: `github`, kind: `capability`, status: `connected` })], {
        capabilities: [capability(`github`, `cli`, { provider: `github` })],
        extensions: [connectors],
    })[0];
    expect([connector?.gateSubject, connector?.sessionShaped]).toEqual([`github`, false]);
});
