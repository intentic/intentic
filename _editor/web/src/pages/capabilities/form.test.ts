import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import { type ForticlientConnection, VAULTED } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import {
    buildConfig,
    cleanName,
    fieldError,
    fieldInvalid,
    fieldMissing,
    fieldVerified,
    forticlientAnswers,
    formComplete,
    inlineField,
    keepsSecret,
    nameError,
    seedValues,
    shownFields,
} from "./form";

/* What the form refuses, what it starts as, and what survives into the config. The interesting cases are the ones
 * that used to cost a round-trip to the daemon or a silently wrong credential. */

const card = (fields: CapabilityCatalogEntry["fields"], overrides: Partial<CapabilityCatalogEntry> = {}): CapabilityCatalogEntry => ({
    id: `vpn`,
    name: `VPN`,
    kind: `vpn`,
    category: `servers`,
    description: `Reach a private network.`,
    fields,
    ...overrides,
});

/* A typed name is REPAIRED rather than refused: "My GitHub" is not invalid, it is `My-GitHub` spelt the way a
 * person spells things. The page shows the repair under the box and submits the repaired form, so the only
 * name left to refuse is one with nothing salvageable in it. */
test(`repairs a typed name instead of refusing it`, () => {
    expect(cleanName(`My GitHub`)).toBe(`My-GitHub`);
    expect(cleanName(`  ops box (new)  `)).toBe(`ops-box-new`);
    expect(cleanName(`-nope-`)).toBe(`nope`);
    expect(cleanName(`ops-box_2`)).toBe(`ops-box_2`);
    expect(cleanName(`…`)).toBe(``);

    expect(nameError(`  `)).toBe(`Name is required.`);
    expect(nameError(`…`)).toBe(`Name is required.`);
    // Anything the repair can save is not an error any more.
    expect(nameError(`My GitHub`)).toBeUndefined();
    expect(nameError(`ops-box_2`)).toBeUndefined();
});

/* MISSING AND MALFORMED ARE DIFFERENT FAILURES: an empty required box merely tabbed past gets a quiet
 * "Required", a malformed value that is actually there gets the red treatment. The split is what the page's
 * two severities are built on. */
test(`tells an unanswered question from a wrong answer`, () => {
    expect(fieldMissing({ key: `server`, label: `Server` }, ``)).toBe(true);
    expect(fieldMissing({ key: `server`, label: `Server` }, `vpn.acme.dev`)).toBe(false);
    expect(fieldMissing({ key: `note`, label: `Note`, optional: true }, ``)).toBe(false);
    // Emptiness is never "invalid": it is not yet anything.
    expect(fieldInvalid({ key: `server`, label: `Server` }, ``)).toBeUndefined();
    expect(fieldInvalid({ key: `url`, label: `URL` }, `not a url`)).toContain(`Enter a valid URL`);
});

// The green check, only for the values a rule can genuinely vouch for.
test(`vouches only for what a rule can check`, () => {
    expect(fieldVerified({ key: `url`, label: `URL` }, `https://github.com/o/r`)).toBe(true);
    expect(fieldVerified({ key: `url`, label: `URL` }, `github.com/o/r`)).toBe(false);
    expect(fieldVerified({ key: `port`, label: `Port` }, `10443`)).toBe(true);
    expect(fieldVerified({ key: `ref`, label: `Commit sha` }, `a`.repeat(40))).toBe(true);
    expect(fieldVerified({ key: `ref`, label: `Commit sha` }, `main`)).toBe(false);
    // Free text earns no check: the form cannot vouch for a hostname it has never dialled.
    expect(fieldVerified({ key: `host`, label: `Host` }, `db.acme.dev`)).toBe(false);
    // Nor does a secret, whose correctness no pattern can promise.
    expect(fieldVerified({ key: `tokenUrl`, label: `Token`, secret: true }, `https://x`)).toBe(false);
});

// The FortiClient ciphertext check is here rather than after a POST: the daemon rejects an EncX blob, and being
// told so by the field beats being told so by a 400.
test(`objects to what the daemon would reject, before the round-trip`, () => {
    expect(fieldError({ key: `password`, label: `Password`, secret: true }, `EncX 3D2A9F1B7C`)).toContain(`FortiClient encrypted this`);
    expect(fieldError({ key: `url`, label: `URL` }, `github.com/owner/repo`)).toContain(`Enter a valid URL`);
    expect(fieldError({ key: `port`, label: `Port` }, `70000`)).toContain(`1–65535`);
    expect(fieldError({ key: `port`, label: `Port` }, `10443`)).toBeUndefined();
    // The local model card's typed conversation window: gigabytes of RAM ride on this number, so a stray comma
    // or a fat-fingered million is worth catching in the box rather than in a failed apply.
    expect(fieldError({ key: `contextTokens`, label: `Window in tokens` }, `98,304`)).toContain(`whole number of tokens`);
    expect(fieldError({ key: `contextTokens`, label: `Window in tokens` }, `9999999`)).toContain(`whole number of tokens`);
    expect(fieldError({ key: `contextTokens`, label: `Window in tokens` }, `98304`)).toBeUndefined();
    // A url field that holds a secret is not a url: a token pasted into `tokenUrl` must not be re-read as one.
    expect(fieldError({ key: `tokenUrl`, label: `Token`, secret: true }, `abc123`)).toBeUndefined();
});

test(`asks for what is required and lets an optional field stay empty`, () => {
    expect(fieldError({ key: `server`, label: `Server` }, ``)).toBe(`This field is required.`);
    expect(fieldError({ key: `note`, label: `Note`, optional: true }, ``)).toBeUndefined();
});

/* A `when`-gated field is only on screen, and only asked for, while the mode it hangs off is chosen. This is
 * what keeps the SSH key field from blocking a submit on the password branch. */
test(`shows and requires only the fields the chosen mode keeps`, () => {
    const ssh = card(
        [
            {
                key: `auth`,
                label: `Auth`,
                options: [
                    { value: `key`, label: `Key` },
                    { value: `password`, label: `Password` },
                ],
            },
            { key: `key`, label: `Private key`, when: `auth == 'key'` },
            { key: `password`, label: `Password`, when: `auth == 'password'` },
            { key: `kind`, label: `Kind`, value: `ssh` },
        ],
        { kind: `ssh` },
    );
    const values = { auth: `password`, password: `hunter2`, key: `` };

    // The const-valued field is baked into the config rather than rendered, and the unchosen branch is gone.
    expect(shownFields(ssh, values).map((field) => field.key)).toEqual([`auth`, `password`]);
    expect(formComplete(ssh, values, `ops-box`)).toBe(true);
    // The gated-out credential is not sent, however it was left.
    expect(buildConfig(ssh, { ...values, key: `stale` })).toEqual({ auth: `password`, password: `hunter2`, kind: `ssh` });
});

test(`drops empty answers rather than sending empty keys`, () => {
    const entry = card([
        { key: `server`, label: `Server` },
        { key: `note`, label: `Note`, optional: true },
    ]);

    expect(buildConfig(entry, { server: ` vpn.acme.dev `, note: `  ` })).toEqual({ server: `vpn.acme.dev` });
});

/* THE SEED'S ORDER IS THE ARGUMENT. A one-per-sandbox card opens as an edit of what is live, so its echoed
 * config beats the card's defaults: resetting a switch to off every time the card is opened would turn "come
 * and look" into "turn it back off". */
test(`seeds from the card, then from what is live, then from what the scan read`, () => {
    const entry = card([
        { key: `gpu`, label: `GPU`, boolean: true },
        { key: `socket`, label: `Socket`, default: `/var/run/docker.sock` },
        { key: `url`, label: `Instance URL` },
        { key: `token`, label: `Token`, secret: true },
    ]);

    const fresh = seedValues(entry, undefined, {});
    // A switch seeds to a position it can show; an unseeded one would render as off AND block the submit.
    expect(fresh).toEqual({ gpu: `off`, socket: `/var/run/docker.sock`, url: ``, token: `` });

    const live = seedValues(entry, { gpu: true, socket: `/run/docker.sock` }, {});
    expect(live[`gpu`]).toBe(`on`);
    expect(live[`socket`]).toBe(`/run/docker.sock`);

    // NEVER A SECRET, even when the scan is holding one: a credential is the one thing this will not fill in on
    // the user's behalf. A prefill for a field the card does not declare is dropped with it.
    const scanned = seedValues(entry, undefined, { url: `https://gitlab.acme.dev`, token: `glpat-xxx`, nothing: `here` });
    expect(scanned[`url`]).toBe(`https://gitlab.acme.dev`);
    expect(scanned[`token`]).toBe(``);
    expect(scanned[`nothing`]).toBeUndefined();
});

/* WHAT AN EMPTY CREDENTIAL BOX MEANS, which is the only thing an edit changes, and the reason changing one
 * setting on a connection no longer costs a re-typed key.
 *
 * A connection's credentials never reach the browser, so a form opened over one starts with those boxes blank.
 * Read as an add would read them, the field is unanswered: the submit is blocked until the user goes and finds
 * a credential they already have, and a dropped value erases what is stored. Told which keys are actually held,
 * every rule flips for exactly those boxes and nothing else. */
test(`lets a stored credential be kept, and sends the marker rather than a hole`, () => {
    const entry = card([
        { key: `server`, label: `Gateway` },
        { key: `password`, label: `Password`, secret: true },
    ]);
    const stored = new Set([`password`]);
    const values = { server: `vpn.acme.dev`, password: `` };

    expect(keepsSecret({ key: `password`, label: `Password`, secret: true }, ``, stored)).toBe(true);
    // Adding is unchanged: nothing is stored, so an empty credential is an unanswered question.
    expect(fieldError({ key: `password`, label: `Password`, secret: true }, ``)).toBe(`This field is required.`);
    expect(formComplete(entry, values, `office`)).toBe(false);

    // Editing: the box may be left alone, and the config carries the marker the daemon resolves.
    expect(fieldError({ key: `password`, label: `Password`, secret: true }, ``, stored)).toBeUndefined();
    expect(formComplete(entry, values, `office`, stored)).toBe(true);
    expect(buildConfig(entry, values, stored)).toEqual({ server: `vpn.acme.dev`, password: VAULTED });

    // Typing REPLACES it: a value present is a value meant, and it is still checked like any other.
    expect(buildConfig(entry, { ...values, password: ` hunter2 ` }, stored)).toEqual({ server: `vpn.acme.dev`, password: `hunter2` });
    expect(fieldError({ key: `password`, label: `Password`, secret: true }, `EncX 3D2A9F1B7C`, stored)).toContain(`FortiClient encrypted this`);

    // A key the connection does NOT hold is not kept: an optional credential left blank stays absent.
    expect(buildConfig(entry, { server: `vpn.acme.dev`, password: `` }, new Set())).toEqual({ server: `vpn.acme.dev` });
});

/* An imported connection fills the form, and BLANKS EVERY SECRET first. FortiClient encrypts credentials, so
 * none can be imported, and anything left in those fields belongs to a different connection, which is exactly
 * how an EncX blob reached the daemon once. */
test(`fills the form from an import and leaves no credential of the last connection behind`, () => {
    const fields: CapabilityCatalogEntry["fields"] = [
        { key: `password`, label: `Password`, secret: true },
        { key: `preshared`, label: `Pre-shared key`, secret: true },
    ];
    const ipsec: ForticlientConnection = {
        id: `hq`,
        label: `HQ`,
        provider: `ipsec`,
        server: `vpn.acme.dev`,
        port: 4500,
        needs: [`password`],
        localId: `ada`,
        aggressive: true,
        pfs: false,
        dhGroup: `14`,
    };

    expect(forticlientAnswers(fields, ipsec)).toEqual({
        password: ``,
        preshared: ``,
        provider: `ipsec`,
        server: `vpn.acme.dev`,
        port: `4500`,
        username: ``,
        localId: `ada`,
        aggressive: `on`,
        ikeVersion: `1`,
        pfs: `off`,
        dhGroup: `14`,
    });

    // An SSL-VPN connection carries none of the IPsec phase-1 answers, so the form is not given fields it has no
    // questions for.
    const ssl: ForticlientConnection = {
        id: `hq`,
        label: `HQ`,
        provider: `fortinet`,
        server: `vpn.acme.dev`,
        port: 10_443,
        needs: [],
        username: `ada`,
    };
    expect(forticlientAnswers([], ssl)).toEqual({ provider: `fortinet`, server: `vpn.acme.dev`, port: `10443`, username: `ada` });
});

/* The line is drawn on the WIDTH of the answers, not their number: `Allowed`/`Blocked` and
 * `OpenAI-compatible`/`Anthropic-compatible` are both two options, and only one of them leaves room for a label
 * beside it. */
test(`puts a question beside its label only when the answers fit there`, () => {
    expect(inlineField({ key: `shell`, label: `Run commands`, boolean: true })).toBe(true);
    expect(
        inlineField({
            key: `shell`,
            label: `Run commands`,
            options: [
                { value: `on`, label: `Allowed` },
                { value: `off`, label: `Blocked` },
            ],
        }),
    ).toBe(true);
    expect(
        inlineField({
            key: `protocol`,
            label: `Protocol`,
            options: [
                { value: `openai`, label: `OpenAI-compatible` },
                { value: `anthropic`, label: `Anthropic-compatible` },
            ],
        }),
    ).toBe(false);
    // A plain text field stacks, and so does anything multiline however short its options are.
    expect(inlineField({ key: `server`, label: `Server` })).toBe(false);
});
