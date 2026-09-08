import type { ForticlientConnection } from "@intentic/sandbox-contract";

// Reads an exported FortiClient configuration (File → Settings → Backup) into addable connections.
// EncX-wrapped credentials are not reversible from the file; each is dropped and reported through `needs` rather than
// imported wrong.
// Hand-rolled rather than an XML library: the shapes read are three fixed levels deep, and a lenient reader beats a
// strict one on a pasted export.

// DH groups the ipsec capability can express (IpsecVpnConfigSchema.dhGroup); anything else is dropped, not imported
// wrong.
const SUPPORTED_DH_GROUPS = new Set(["2", "5", "14", "15", "16", "19", "20"]);

// A FortiClient-encrypted value. Never a usable credential here.
const isEncrypted = (value: string): boolean => value.startsWith("EncX ") || value.startsWith("Enc ");

// FortiClient wraps some values in CDATA, not others; this strips the wrapper and whitespace.
const clean = (raw: string): string => {
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
    return (cdata?.[1] ?? raw).trim();
};

// Text of the first <tag> inside `scope`; every field read below is unambiguous within its block, so shallow matching
// is safe.
const tagText = (scope: string, tag: string): string | undefined => {
    const match = new RegExp(`<${tag}\\s*>([\\s\\S]*?)</${tag}>`, "i").exec(scope);
    return match === null ? undefined : clean(match[1] ?? "");
};

// A value only when present, non-empty and not FortiClient-encrypted.
const plainText = (scope: string, tag: string): string | undefined => {
    const value = tagText(scope, tag);
    return value === undefined || value === "" || isEncrypted(value) ? undefined : value;
};

// The <connection> blocks inside the named section (<sslvpn> or <ipsecvpn>); sectioning first keeps an SSL connection
// from reading as IPsec, since both share the element name.
const connectionBlocks = (xml: string, section: string): string[] => {
    const sectionBody = new RegExp(`<${section}\\s*>([\\s\\S]*?)</${section}>`, "i").exec(xml)?.[1];
    if (sectionBody === undefined) {
        return [];
    }
    return [...sectionBody.matchAll(/<connection\s*>([\s\S]*?)<\/connection>/gi)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
};

// Letters whose diacritic strikes through the glyph rather than combines above it, so NFKD alone cannot recover their
// base letter.
const STROKED_LATIN: Record<string, string> = {
    ł: "l",
    đ: "d",
    ð: "d",
    ø: "o",
    æ: "ae",
    œ: "oe",
    ß: "ss",
    þ: "th",
    ħ: "h",
    ŧ: "t",
    ı: "i",
};

// A connection name into a legal capability id (entryId: starts alphanumeric, then letters/digits/hyphen/underscore); a
// name that slugs to nothing gets a positional id instead.
export const slugId = (name: string, index: number): string => {
    const slug = name
        .toLowerCase()
        // Non-ASCII via the property escape, not a code-point range: a literal range here would embed control
        // characters, including a NUL byte.
        .replace(/[^\p{ASCII}]/gu, (char) => STROKED_LATIN[char] ?? char)
        .normalize("NFKD")
        // Drops combining marks so accented Latin keeps its base letter instead of vanishing.
        .replace(/\p{M}+/gu, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return slug === "" ? `vpn-${index + 1}` : slug;
};

// `host:port` split on the last colon; a bracketed IPv6 literal keeps its colons since only a trailing `:<digits>`
// counts as a port.
export const splitServer = (server: string, fallbackPort: number): { host: string; port: number } => {
    const match = /^(.*?):(\d+)$/.exec(server.trim());
    if (match === null || match[1] === undefined || match[1] === "") {
        return { host: server.trim(), port: fallbackPort };
    }
    return { host: match[1], port: Number.parseInt(match[2] ?? "", 10) };
};

// Parses an exported configuration into connections the add form can be filled from; a file with no recognisable
// connections yields an empty list rather than throwing.
export const parseForticlientConfig = (xml: string): ForticlientConnection[] => {
    const connections: ForticlientConnection[] = [];

    connectionBlocks(xml, "sslvpn").forEach((block, index) => {
        const label = tagText(block, "name");
        const server = tagText(block, "server");
        if (label === undefined || label === "" || server === undefined || server === "") {
            return;
        }
        const { host, port } = splitServer(server, 443);
        const username = plainText(block, "username");
        connections.push({
            id: slugId(label, index),
            label,
            provider: "fortinet",
            server: host,
            port,
            ...(username === undefined ? {} : { username }),
            ...(plainText(block, "description") === undefined ? {} : { description: plainText(block, "description") }),
            needs: [...(username === undefined ? ["username"] : []), "password"],
        });
    });

    connectionBlocks(xml, "ipsecvpn").forEach((block, index) => {
        const label = tagText(block, "name");
        // Endpoint and mode live in <ike_settings>; narrowing to it keeps <ipsec_settings>'s own fields from being read
        // as phase-1.
        const ike = /<ike_settings\s*>([\s\S]*?)<\/ike_settings>/i.exec(block)?.[1] ?? block;
        const server = tagText(ike, "server");
        if (label === undefined || label === "" || server === undefined || server === "") {
            return;
        }
        const { host, port } = splitServer(server, 500);
        // The XAuth username is nested in <xauth>; reading the whole block risks picking up an unrelated <username>.
        const xauth = /<xauth\s*>([\s\S]*?)<\/xauth>/i.exec(ike)?.[1] ?? "";
        const username = plainText(xauth, "username");
        const localId = plainText(ike, "localid");
        const xauthEnabled = tagText(xauth, "enabled") === "1";
        // pfs and dhGroup come from <ipsec_settings> (phase 2), not <ike_settings>, which can list several groups
        // without saying which one applies.
        const phase2 = /<ipsec_settings\s*>([\s\S]*?)<\/ipsec_settings>/i.exec(block)?.[1] ?? "";
        const dhGroup = tagText(phase2, "dhgroup");
        connections.push({
            id: slugId(label, index),
            label,
            provider: "ipsec",
            server: host,
            port,
            ...(username === undefined ? {} : { username }),
            ...(localId === undefined ? {} : { localId }),
            aggressive: tagText(ike, "mode")?.toLowerCase() === "aggressive",
            // FortiClient omits <pfs> when it is on; only an explicit 0 turns it off.
            pfs: tagText(phase2, "pfs") !== "0",
            ...(dhGroup !== undefined && SUPPORTED_DH_GROUPS.has(dhGroup) ? { dhGroup } : {}),
            // The pre-shared key is always EncX-wrapped in an export, so it is always in `needs`.
            needs: ["presharedKey", ...(xauthEnabled && username === undefined ? ["username"] : []), ...(xauthEnabled ? ["password"] : [])],
        });
    });

    return connections;
};
