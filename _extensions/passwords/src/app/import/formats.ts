import { normalizeHost } from "@intentic/sandbox-contract/policy/keyring-origins";
import { KEYRING_PACKAGE_RE, type KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import type { ImportRow } from "../port.js";
import { parseCsv } from "./csv.js";

// ONE PARSER PER EXPORT, told apart by the file's header rather than its name or the person's word for it: a file
// called passwords.csv from Brave and one from Bitwarden differ only in their first line. Each format names the columns
// it reads; a row with no password, or no place it can be used, is counted as skipped rather than guessed at.

export type ImportFormatId = "chrome" | "firefox" | "safari" | "1password" | "bitwarden" | "keepassxc";

interface ImportFormat {
    readonly id: ImportFormatId;
    /** What the preview calls the file: "Chrome, Edge or Brave". */
    readonly label: string;
    /** Whether this is the format, by the header's lower-cased column names. */
    readonly is: (header: ReadonlySet<string>) => boolean;
    /** The columns it reads, by their lower-cased header names; the first present wins. */
    readonly columns: {
        readonly url: readonly string[];
        readonly title: readonly string[];
        readonly username: readonly string[];
        readonly password: readonly string[];
        readonly note: readonly string[];
    };
    /** A row that is not a login at all (a Bitwarden card, a secure note): skipped. */
    readonly login?: (cell: (name: string) => string) => boolean;
}

const has =
    (...names: string[]) =>
    (header: ReadonlySet<string>): boolean =>
        names.every((name) => header.has(name));

// Most particular first: Safari's and 1Password's headers are both Title,URL,Username,Password,…, and Chrome's columns
// are a subset of more than one other.
const FORMATS: readonly ImportFormat[] = [
    {
        id: "bitwarden",
        label: "Bitwarden",
        is: has("login_uri", "login_password"),
        columns: { url: ["login_uri"], title: ["name"], username: ["login_username"], password: ["login_password"], note: ["notes"] },
        login: (cell) => cell("type") === "" || cell("type") === "login",
    },
    {
        id: "keepassxc",
        label: "KeePassXC",
        is: (header) => has("group", "title", "password")(header) && (header.has("last modified") || header.has("totp") || header.has("icon")),
        columns: { url: ["url"], title: ["title"], username: ["username"], password: ["password"], note: ["notes"] },
    },
    {
        id: "firefox",
        label: "Firefox",
        is: has("url", "password", "httprealm"),
        columns: { url: ["url"], title: [], username: ["username"], password: ["password"], note: [] },
    },
    {
        id: "1password",
        label: "1Password",
        is: (header) => header.has("title") && header.has("password") && ["archived", "favorite", "tags", "website"].some((name) => header.has(name)),
        columns: { url: ["url", "website", "urls"], title: ["title"], username: ["username"], password: ["password"], note: ["notes", "notesplain"] },
    },
    {
        id: "safari",
        label: "Safari",
        is: has("title", "url", "username", "password"),
        columns: { url: ["url"], title: ["title"], username: ["username"], password: ["password"], note: ["notes"] },
    },
    {
        id: "chrome",
        label: "Chrome, Edge or Brave",
        is: has("name", "url", "username", "password"),
        columns: { url: ["url"], title: ["name"], username: ["username"], password: ["password"], note: ["note"] },
    },
];

/** The labels the import step names, in the order it lists them. */
/**
 * Where an exported login is used, from its address: a site by its host, an Android app by the package Chrome writes as
 * `android://…@com.example.app/`. Undefined for an address that names neither.
 */
export const originOfUrl = (raw: string): KeyringOrigin | undefined => {
    const url = raw.trim().split(/\s+/u)[0] ?? "";
    if (url === "") {
        return undefined;
    }
    const android = /^android:\/\/[^@]*@([^/]+)/u.exec(url);
    if (android !== null) {
        const pkg = android[1] ?? "";
        return KEYRING_PACKAGE_RE.test(pkg) ? { kind: "package", package: pkg } : undefined;
    }
    try {
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(url) ? url : `https://${url}`);
        const host = normalizeHost(parsed.hostname);
        return host === "" || !host.includes(".") && host !== "localhost" ? undefined : { kind: "site", host };
    } catch {
        // allow(silent-catch): an address that is not one is a row with no place, counted as skipped by the caller
        return undefined;
    }
};

export interface ParsedImport {
    readonly format: ImportFormatId;
    readonly label: string;
    readonly rows: readonly ImportRow[];
    /** Rows left out: no password, no place it is used, or not a login. */
    readonly skipped: number;
}

// An empty cell is no title, no user, no note: absent rather than "", so the keyring derives its own.
const present = (text: string, max: number): string | undefined => (text === "" ? undefined : text.slice(0, max));

/** The file's logins, or undefined when its header is none of the formats above. */
export const parseImport = (text: string): ParsedImport | undefined => {
    const [head, ...body] = parseCsv(text);
    if (head === undefined) {
        return undefined;
    }
    const names = head.map((name) => name.trim().toLowerCase());
    const header = new Set(names);
    const format = FORMATS.find((candidate) => candidate.is(header));
    if (format === undefined) {
        return undefined;
    }
    const rows: ImportRow[] = [];
    let skipped = 0;
    for (const cells of body) {
        const cell = (name: string): string => {
            const at = names.indexOf(name);
            return at < 0 ? "" : (cells[at] ?? "").trim();
        };
        const first = (columns: readonly string[]): string => columns.map(cell).find((value) => value !== "") ?? "";
        // A password is kept as it was written: a leading or trailing space may be part of it.
        const passwordAt = format.columns.password.map((name) => names.indexOf(name)).find((at) => at >= 0) ?? -1;
        const value = passwordAt < 0 ? "" : (cells[passwordAt] ?? "");
        const origin = originOfUrl(first(format.columns.url));
        if (value === "" || origin === undefined || (format.login !== undefined && !format.login(cell))) {
            skipped += 1;
            continue;
        }
        const title = first(format.columns.title);
        const username = first(format.columns.username);
        const note = first(format.columns.note);
        rows.push({ origin, title: present(title, 200), username: present(username, 256), value, note: present(note, 500) });
    }
    return { format: format.id, label: format.label, rows, skipped };
};
