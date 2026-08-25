import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";

/* REPAIR BEFORE REFUSING. Everything in this module exists to close the gap between what a person naturally
 * pastes or types and what the daemon's schema accepts, in the direction of fixing it for them: trim the
 * newline off a copied token, put the scheme on a bare host, split the connection string they were going to
 * split by hand. Each repair is VISIBLE, the value in the box changes, or a one-line account of what was read
 * appears under it, so the form never silently disagrees with what was typed.
 *
 * Pure functions over (field, value), no reactivity: the page decides when to run them (blur for the quiet
 * repairs, paste for the expansions) and what to draw with the answers. */

// ---------------------------------------------------------------------------
// The quiet repairs: run on blur, written straight back into the box.
// ---------------------------------------------------------------------------

// The hosts that resolve to the CONTAINER rather than the machine the user is thinking of.
const LOCAL_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

const isUrlField = (field: CapabilityField): boolean =>
    field.secret !== true && field.multiline !== true && field.options === undefined && field.key.toLowerCase().includes(`url`);

/* What a field's value becomes when the reader is done with it. Trim always (the trailing newline on a pasted
 * token is the classic invisible failure); digits-only for a port ("10,443" means 10443); a scheme for a bare
 * host in a URL box, http for the hosts that are plainly local, https for the world. */
export const normalizeFieldValue = (field: CapabilityField, raw: string): string => {
    let value = raw.trim();
    if (value.length === 0) {
        return value;
    }
    if (field.key === `port`) {
        return value.replace(/\D+/gu, ``);
    }
    if (isUrlField(field) && !SCHEME_RE.test(value)) {
        const host = value.split(/[/:?#]/, 1)[0] ?? ``;
        const scheme = LOCAL_HOST_RE.test(host) || host === `host.docker.internal` ? `http` : `https`;
        value = `${scheme}://${value}`;
    }
    return value;
};

/* THE LOCALHOST TRAP, and its one-click way out. A URL in a capability's config is dialled FROM the sandbox,
 * and the sandbox is a container: localhost is the container itself, so `http://localhost:11434` reaches
 * nothing and fails with a timeout nobody can attribute. The paragraph of prose this used to take on three
 * different cards becomes a chip that fixes it. Returns the corrected URL, or undefined when there is nothing
 * to correct. */
export const containerUrlFix = (field: CapabilityField, value: string | undefined): string | undefined => {
    const trimmed = (value ?? ``).trim();
    if (!isUrlField(field) || trimmed.length === 0) {
        return undefined;
    }
    const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/:?#]+)([\s\S]*)$/i.exec(trimmed);
    if (match === null || !LOCAL_HOST_RE.test(match[2] ?? ``)) {
        return undefined;
    }
    return `${match[1]}host.docker.internal${match[3]}`;
};

// ---------------------------------------------------------------------------
// The expansions: one paste answers several fields, and says what it read.
// ---------------------------------------------------------------------------

export interface PasteExpansion {
    /** field key → answer. Keys not named keep whatever they hold. */
    readonly values: Record<string, string>;
    /** The one-line account of what was read, printed under the field that took the paste. */
    readonly summary: string;
}

const hasField = (entry: CapabilityCatalogEntry, key: string): boolean => entry.fields.some((field) => field.key === key);

/* An SSH target as people actually carry them: `root@1.2.3.4`, `root@box:2222`, or the whole `ssh -p 2222
 * root@box` command copied out of a shell history. Parsed rather than refused, because the string already
 * contains every answer the form's three boxes ask for. */
const parseSshTarget = (pasted: string): PasteExpansion | undefined => {
    const tokens = pasted.trim().split(/\s+/u);
    if (tokens[0] === `ssh`) {
        tokens.shift();
    }
    let port: string | undefined;
    let target: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? ``;
        if (token === `-p` || token === `-P`) {
            port = tokens[index + 1];
            index += 1;
            continue;
        }
        if (token.startsWith(`-`)) {
            continue;
        }
        target = target ?? token;
    }
    if (target === undefined) {
        return undefined;
    }
    const match = /^(?:([^@\s]+)@)?([\w.-]+)(?::(\d+))?$/u.exec(target);
    if (match === null) {
        return undefined;
    }
    const [, user, host, targetPort] = match;
    const values: Record<string, string> = { host: host ?? `` };
    const parts = [`host ${host}`];
    const chosenPort = port ?? targetPort;
    if (chosenPort !== undefined) {
        values[`port`] = chosenPort;
        parts.push(`port ${chosenPort}`);
    }
    if (user !== undefined) {
        values[`user`] = user;
        parts.push(`user ${user}`);
    }
    // A bare hostname with nothing else read from it is not an expansion, it is just a hostname.
    if (parts.length === 1) {
        return undefined;
    }
    return { values, summary: `Read from the paste: ${parts.join(` · `)}.` };
};

/* A database connection string, the form every provider's dashboard hands out and this form used to make
 * people take apart by hand. One paste fills all five boxes; the summary names what landed where, password
 * included but never echoed. */
const parseConnectionString = (entry: CapabilityCatalogEntry, pasted: string): PasteExpansion | undefined => {
    if (!/^(postgres(?:ql)?|mysql):\/\//i.test(pasted.trim()) || !hasField(entry, `database`) || !hasField(entry, `host`)) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(pasted.trim());
    } catch {
        return undefined;
    }
    if (url.hostname.length === 0) {
        return undefined;
    }
    const database = decodeURIComponent(url.pathname.replace(/^\//u, ``));
    const values: Record<string, string> = { host: url.hostname };
    const parts = [`host ${url.hostname}`];
    if (url.port.length > 0) {
        values[`port`] = url.port;
        parts.push(`port ${url.port}`);
    }
    if (database.length > 0) {
        values[`database`] = database;
        parts.push(`database ${database}`);
    }
    if (url.username.length > 0) {
        values[`user`] = decodeURIComponent(url.username);
        parts.push(`user ${decodeURIComponent(url.username)}`);
    }
    if (url.password.length > 0) {
        values[`password`] = decodeURIComponent(url.password);
        parts.push(`password set`);
    }
    return { values, summary: `Read from the connection string: ${parts.join(` · `)}.` };
};

/* A repository DEEP link (…/tree/<ref>/<path>, …/commit/<sha>) split into the three boxes it answers. People
 * copy the URL of the page they are looking at, not the clone URL, and the difference between the two was a
 * refusal on this form. GitHub and GitLab shapes; a plain repo URL passes through untouched. */
const parseRepoDeepLink = (entry: CapabilityCatalogEntry, pasted: string): PasteExpansion | undefined => {
    if (!hasField(entry, `ref`)) {
        return undefined;
    }
    const match = /^(https?:\/\/[^/\s]+\/[^\s]+?)\/(?:-\/)?(tree|commit|blob)\/([^/\s]+)(?:\/([^\s]*?))?\/?$/iu.exec(pasted.trim());
    if (match === null) {
        return undefined;
    }
    const [, repo, verb, ref, path] = match;
    const values: Record<string, string> = { url: repo ?? ``, ref: ref ?? `` };
    const parts = [`repository ${repo}`, verb === `commit` ? `commit ${(ref ?? ``).slice(0, 12)}` : `ref ${ref}`];
    if (path !== undefined && path.length > 0 && hasField(entry, `path`)) {
        // A blob link names a file; the subdirectory the form wants is the folder it sits in.
        const directory = verb === `blob` ? path.split(`/`).slice(0, -1).join(`/`) : path;
        if (directory.length > 0) {
            values[`path`] = directory;
            parts.push(`subdirectory ${directory}`);
        }
    }
    return { values, summary: `Split the link: ${parts.join(` · `)}.` };
};

/* The IMAP settings a mail address already implies. The big providers' hosts are a lookup, not knowledge
 * anyone should need, so pasting the address into Username fills them, and only where the boxes still hold
 * their defaults, a host somebody typed is theirs. */
const IMAP_HOSTS: Readonly<Record<string, string>> = {
    "gmail.com": `imap.gmail.com`,
    "googlemail.com": `imap.gmail.com`,
    "outlook.com": `outlook.office365.com`,
    "hotmail.com": `outlook.office365.com`,
    "live.com": `outlook.office365.com`,
    "office365.com": `outlook.office365.com`,
    "yahoo.com": `imap.mail.yahoo.com`,
    "icloud.com": `imap.mail.me.com`,
    "me.com": `imap.mail.me.com`,
    "fastmail.com": `imap.fastmail.com`,
    "gmx.net": `imap.gmx.net`,
    "gmx.de": `imap.gmx.net`,
    "web.de": `imap.web.de`,
    "zoho.com": `imap.zoho.com`,
};

const parseImapAddress = (entry: CapabilityCatalogEntry, values: Readonly<Record<string, string>>, pasted: string): PasteExpansion | undefined => {
    if (!hasField(entry, `host`) || !hasField(entry, `mailbox`)) {
        return undefined;
    }
    const address = pasted.trim();
    const domain = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/u.exec(address)?.[1]?.toLowerCase();
    const host = domain === undefined ? undefined : IMAP_HOSTS[domain];
    if (host === undefined) {
        return undefined;
    }
    const expansion: Record<string, string> = { username: address };
    const current = (values[`host`] ?? ``).trim();
    if (current.length > 0 && current !== host) {
        // A host already typed is not overwritten by a guess; the address still lands in its own box.
        return undefined;
    }
    expansion[`host`] = host;
    expansion[`port`] = `993`;
    return { values: expansion, summary: `${domain}'s mail server is ${host}:993, filled in for you.` };
};

/* One paste, routed to whichever expansion recognises it. `field` is where the paste landed, which is part of
 * the meaning: a connection string in the Host box and an email in the Username box are both "I have this,
 * you sort it out", and sorting it out is this form's job. */
export const expandPaste = (
    entry: CapabilityCatalogEntry,
    field: CapabilityField,
    values: Readonly<Record<string, string>>,
    pasted: string,
): PasteExpansion | undefined => {
    if (entry.kind === `ssh` && (field.key === `host` || field.key === `user`)) {
        return parseSshTarget(pasted);
    }
    if (field.key === `host` || field.key === `port` || field.key === `database` || field.key === `user`) {
        const connection = parseConnectionString(entry, pasted);
        if (connection !== undefined) {
            return connection;
        }
    }
    if (field.key === `username`) {
        const imap = parseImapAddress(entry, values, pasted);
        if (imap !== undefined) {
            return imap;
        }
    }
    if (field.key === `url`) {
        return parseRepoDeepLink(entry, pasted);
    }
    return undefined;
};

// ---------------------------------------------------------------------------
// The live account of an opaque paste: what a WireGuard blob actually holds.
// ---------------------------------------------------------------------------

export interface ConfSummary {
    readonly text: string;
    /** True when the blob is recognisably broken (a config that lost its [Peer]) rather than merely described. */
    readonly warning: boolean;
}

/* A WireGuard textarea is a wall the reader cannot check: did both files make it, did the copy lose the
 * [Peer]? This reads the blob the way the daemon will and says what it found, so the check happens in the box
 * rather than after a failed connect. Countries come from the `# country: XX` convention the exit card
 * documents; absence is not an error, the daemon has its own placement pass. */
export const wireguardSummary = (value: string | undefined): ConfSummary | undefined => {
    const text = (value ?? ``).trim();
    if (text.length === 0) {
        return undefined;
    }
    const interfaces = (text.match(/^\s*\[interface\]/gim) ?? []).length;
    if (interfaces === 0) {
        return undefined;
    }
    const peers = (text.match(/^\s*\[peer\]/gim) ?? []).length;
    const endpoints = [...text.matchAll(/^\s*endpoint\s*=\s*(\S+)/gim)].map((match) => match[1] ?? ``);
    const countries = [...new Set([...text.matchAll(/^\s*#\s*country:\s*([a-z]{2})\b/gim)].map((match) => (match[1] ?? ``).toUpperCase()))];
    const parts = [`${interfaces} config${interfaces === 1 ? `` : `s`}`];
    if (peers < interfaces) {
        return {
            text: `${parts[0]}, but only ${peers} [Peer] section${peers === 1 ? `` : `s`}: a config without its peer can't connect. Check the paste.`,
            warning: true,
        };
    }
    if (endpoints.length > 0) {
        parts.push(endpoints.length === 1 ? `endpoint ${endpoints[0]}` : `${endpoints.length} endpoints`);
    }
    if (countries.length > 0) {
        parts.push(countries.join(`, `));
    }
    return { text: `Read: ${parts.join(` · `)}.`, warning: false };
};

// Whether this field is the kind the summary above narrates: a multiline WireGuard config box.
export const summarisesWireguard = (entry: CapabilityCatalogEntry, field: CapabilityField): boolean =>
    field.key === `config` && field.multiline === true && (entry.kind === `vpn` || entry.kind === `exit`);
