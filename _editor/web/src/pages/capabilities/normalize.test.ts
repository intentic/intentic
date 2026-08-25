import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import { expect, test } from "vitest";
import { containerUrlFix, expandPaste, normalizeFieldValue, wireguardSummary } from "./normalize";

/* Repair before refusing: each case here is a thing a person actually pastes or types, and what the form now
 * does with it instead of objecting. */

const card = (kind: CapabilityCatalogEntry["kind"], fields: CapabilityCatalogEntry["fields"]): CapabilityCatalogEntry => ({
    id: `card`,
    name: `Card`,
    kind,
    category: `servers`,
    description: `A card.`,
    fields,
});

test(`repairs what blur can repair: whitespace, ports, bare hosts`, () => {
    expect(normalizeFieldValue({ key: `token`, label: `Token`, secret: true }, `ghp_abc\n`)).toBe(`ghp_abc`);
    expect(normalizeFieldValue({ key: `port`, label: `Port` }, `10,443`)).toBe(`10443`);
    expect(normalizeFieldValue({ key: `url`, label: `URL` }, `github.com/o/r`)).toBe(`https://github.com/o/r`);
    // The plainly-local hosts get http, because that is what a service on this machine actually speaks.
    expect(normalizeFieldValue({ key: `baseUrl`, label: `URL` }, `host.docker.internal:11434/v1`)).toBe(`http://host.docker.internal:11434/v1`);
    // A scheme already there is the user's answer, not ours to change.
    expect(normalizeFieldValue({ key: `url`, label: `URL` }, `http://example.com`)).toBe(`http://example.com`);
    // Not a URL field: no scheme is invented for a hostname box.
    expect(normalizeFieldValue({ key: `host`, label: `Host` }, `db.acme.dev`)).toBe(`db.acme.dev`);
});

/* The localhost trap: a URL in a capability's config is dialled FROM the sandbox, which is a container, so
 * localhost is the sandbox itself. The fix keeps everything but the host, scheme included: the service is
 * whatever it is, only its address was wrong. */
test(`offers the container-reachable rewrite of a localhost URL`, () => {
    expect(containerUrlFix({ key: `baseUrl`, label: `URL` }, `http://localhost:11434/v1`)).toBe(`http://host.docker.internal:11434/v1`);
    expect(containerUrlFix({ key: `baseUrl`, label: `URL` }, `https://127.0.0.1:27124`)).toBe(`https://host.docker.internal:27124`);
    expect(containerUrlFix({ key: `baseUrl`, label: `URL` }, `https://host.docker.internal:27124`)).toBeUndefined();
    expect(containerUrlFix({ key: `baseUrl`, label: `URL` }, `https://example.com`)).toBeUndefined();
    // A localhost that is not in a URL field is somebody's business, not ours.
    expect(containerUrlFix({ key: `host`, label: `Host` }, `localhost`)).toBeUndefined();
});

test(`unpacks an ssh target however it was carried`, () => {
    const ssh = card(`ssh`, [
        { key: `host`, label: `Host` },
        { key: `port`, label: `Port` },
        { key: `user`, label: `User` },
    ]);
    const hostField = { key: `host`, label: `Host` };

    expect(expandPaste(ssh, hostField, {}, `root@1.2.3.4`)?.values).toEqual({ host: `1.2.3.4`, user: `root` });
    expect(expandPaste(ssh, hostField, {}, `root@box.acme.dev:2222`)?.values).toEqual({ host: `box.acme.dev`, port: `2222`, user: `root` });
    expect(expandPaste(ssh, hostField, {}, `ssh -p 2222 root@box.acme.dev`)?.values).toEqual({ host: `box.acme.dev`, port: `2222`, user: `root` });
    // A bare hostname holds nothing beyond what the box asks for: an ordinary paste, not an expansion.
    expect(expandPaste(ssh, hostField, {}, `box.acme.dev`)).toBeUndefined();
});

test(`takes a database connection string apart so nobody has to`, () => {
    const postgres = card(`cli`, [
        { key: `host`, label: `Host` },
        { key: `port`, label: `Port` },
        { key: `user`, label: `User` },
        { key: `password`, label: `Password`, secret: true },
        { key: `database`, label: `Database` },
    ]);
    const expansion = expandPaste(postgres, { key: `host`, label: `Host` }, {}, `postgres://ada:s3cret@db.acme.dev:5433/orders`);
    expect(expansion?.values).toEqual({ host: `db.acme.dev`, port: `5433`, user: `ada`, password: `s3cret`, database: `orders` });
    // The password lands in its box and is never echoed in the account of what was read.
    expect(expansion?.summary).toContain(`password set`);
    expect(expansion?.summary).not.toContain(`s3cret`);
    // A card without the fields to answer is not offered somebody else's parsing.
    expect(expandPaste(card(`cli`, [{ key: `host`, label: `Host` }]), { key: `host`, label: `Host` }, {}, `postgres://a@b/c`)).toBeUndefined();
});

test(`splits a repository deep link into url, ref and subdirectory`, () => {
    const extension = card(`extension`, [
        { key: `url`, label: `Git URL` },
        { key: `ref`, label: `Commit sha` },
        { key: `path`, label: `Subdirectory` },
    ]);
    const urlField = { key: `url`, label: `Git URL` };
    const sha = `0123456789abcdef0123456789abcdef01234567`;

    expect(expandPaste(extension, urlField, {}, `https://github.com/o/r/commit/${sha}`)?.values).toEqual({
        url: `https://github.com/o/r`,
        ref: sha,
    });
    expect(expandPaste(extension, urlField, {}, `https://github.com/o/r/tree/main/packs/discord`)?.values).toEqual({
        url: `https://github.com/o/r`,
        ref: `main`,
        path: `packs/discord`,
    });
    // GitLab spells the same page with /-/.
    expect(expandPaste(extension, urlField, {}, `https://gitlab.acme.dev/o/r/-/tree/main/pack`)?.values).toEqual({
        url: `https://gitlab.acme.dev/o/r`,
        ref: `main`,
        path: `pack`,
    });
    // A blob link names a file; the subdirectory is the folder it sits in.
    expect(expandPaste(extension, urlField, {}, `https://github.com/o/r/blob/main/pack/intentic-extension.json`)?.values).toEqual({
        url: `https://github.com/o/r`,
        ref: `main`,
        path: `pack`,
    });
    // A plain repo URL is already the answer: nothing to split.
    expect(expandPaste(extension, urlField, {}, `https://github.com/o/r`)).toBeUndefined();
});

test(`fills the mail settings an address already implies, without overwriting a typed host`, () => {
    const imap = card(`cli`, [
        { key: `host`, label: `IMAP host` },
        { key: `port`, label: `Port` },
        { key: `username`, label: `Username` },
        { key: `mailbox`, label: `Watched mailbox` },
    ]);
    const usernameField = { key: `username`, label: `Username` };

    expect(expandPaste(imap, usernameField, {}, `ada@gmail.com`)?.values).toEqual({
        username: `ada@gmail.com`,
        host: `imap.gmail.com`,
        port: `993`,
    });
    // A host somebody already typed is theirs; the guess stands down entirely.
    expect(expandPaste(imap, usernameField, { host: `mail.acme.dev` }, `ada@gmail.com`)).toBeUndefined();
    // An unknown domain implies nothing: ordinary paste.
    expect(expandPaste(imap, usernameField, {}, `ada@acme.dev`)).toBeUndefined();
});

test(`reads a WireGuard blob back to its owner, and flags a config that lost its peer`, () => {
    const conf = `[Interface]\nPrivateKey = x\nAddress = 10.2.0.2/32\n\n[Peer]\nPublicKey = y\nEndpoint = de.example.com:51820\n`;
    expect(wireguardSummary(conf)?.text).toBe(`Read: 1 config · endpoint de.example.com:51820.`);
    expect(wireguardSummary(conf)?.warning).toBe(false);

    const two = `# country: DE\n${conf}\n# country: NL\n${conf.replace(`de.`, `nl.`)}`;
    expect(wireguardSummary(two)?.text).toBe(`Read: 2 configs · 2 endpoints · DE, NL.`);

    const broken = `[Interface]\nPrivateKey = x\n`;
    expect(wireguardSummary(broken)?.warning).toBe(true);
    expect(wireguardSummary(broken)?.text).toContain(`can't connect`);

    expect(wireguardSummary(``)).toBeUndefined();
    expect(wireguardSummary(`not a config`)).toBeUndefined();
});
