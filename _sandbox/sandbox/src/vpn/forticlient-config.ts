import type { ForticlientConnection } from "@intentic/sandbox-contract";

// Reading an exported FortiClient configuration (File → Settings → Backup) into addable connections, so a user
// who has that file picks a connection instead of re-keying its endpoint and protocol.
//
// What can and cannot be recovered is the whole story here. FortiClient wraps stored credentials, and often
// the username too, in its proprietary "EncX <hex>" format, keyed to the machine that exported it. That is not
// reversible from a config file, and pretending otherwise would produce silently-wrong connections, so every
// EncX value is DROPPED and reported through `needs` as something the user must type. The endpoint, protocol,
// identity and mode, the tedious parts, all sit in the clear and are what this actually saves.
//
// Hand-rolled rather than an XML dependency: the shapes needed are three fixed nestings deep, the input is a
// file the user pastes (so a lenient reader beats a strict one that rejects a slightly-off export), and the
// daemon has no XML parser otherwise.

// The DH groups the ipsec capability can express (IpsecVpnConfigSchema.dhGroup). A group outside this set is
// dropped rather than imported wrong, the user then picks one, instead of getting a silent mismatch.
const SUPPORTED_DH_GROUPS = new Set(["2", "5", "14", "15", "16", "19", "20"]);

// A FortiClient-encrypted value. Never a usable credential here.
const isEncrypted = (value: string): boolean => value.startsWith("EncX ") || value.startsWith("Enc ");

// Strip CDATA wrappers and surrounding whitespace. FortiClient wraps some values, not others.
const clean = (raw: string): string => {
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
    return (cdata?.[1] ?? raw).trim();
};

// The text of the FIRST <tag> directly inside `scope`. Deliberately shallow-agnostic: every field read below is
// unambiguous within its connection block, and shallowness would only reject valid exports.
const tagText = (scope: string, tag: string): string | undefined => {
    const match = new RegExp(`<${tag}\\s*>([\\s\\S]*?)</${tag}>`, "i").exec(scope);
    return match === null ? undefined : clean(match[1] ?? "");
};

// A value only when it is present, non-empty and NOT FortiClient-encrypted.
const plainText = (scope: string, tag: string): string | undefined => {
    const value = tagText(scope, tag);
    return value === undefined || value === "" || isEncrypted(value) ? undefined : value;
};

// The <connection>…</connection> blocks inside the named section (<sslvpn> or <ipsecvpn>). Sectioning first is
// what keeps an SSL connection from being read as an IPsec one, both use the same element name.
const connectionBlocks = (xml: string, section: string): string[] => {
    const sectionBody = new RegExp(`<${section}\\s*>([\\s\\S]*?)</${section}>`, "i").exec(xml)?.[1];
    if (sectionBody === undefined) {
        return [];
    }
    return [...sectionBody.matchAll(/<connection\s*>([\s\S]*?)<\/connection>/gi)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
};

// Latin letters whose base form NFKD cannot recover, because the diacritic is a stroke or bar THROUGH the
// glyph rather than a combining mark над it, so "Łódź" would otherwise slug to "odz", silently losing its
// first letter. Only the letters a European VPN connection name realistically carries.
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

// A FortiClient connection name into a legal capability id (the contract's entryId: starts alphanumeric, then
// letters/digits/hyphen/underscore). "ZTM Warszawa" → "ztm-warszawa", "Łódź" → "lodz". A name that slugs to
// nothing (all punctuation, or a script with no Latin fallback) gets a positional id so it stays importable.
export const slugId = (name: string, index: number): string => {
    const slug = name
        .toLowerCase()
        // Non-ASCII only, spelled as the property escape rather than as a code-point range: the range says the
        // same thing with two control characters inside it, which is a lint error, and, typed literally as it
        // was, a NUL byte that made this whole file read as binary to git, to grep and to every diff viewer.
        .replace(/[^\p{ASCII}]/gu, (char) => STROKED_LATIN[char] ?? char)
        .normalize("NFKD")
        // Drop combining marks so accented Latin keeps its base letter (ó → o) instead of vanishing below.
        .replace(/\p{M}+/gu, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return slug === "" ? `vpn-${index + 1}` : slug;
};

// "host:port" → parts, defaulting to 443 (FortiClient omits the port when the gateway uses it). An IPv6
// literal in brackets keeps its colons; only a trailing ":<digits>" is treated as a port.
export const splitServer = (server: string, fallbackPort: number): { host: string; port: number } => {
    const match = /^(.*?):(\d+)$/.exec(server.trim());
    if (match === null || match[1] === undefined || match[1] === "") {
        return { host: server.trim(), port: fallbackPort };
    }
    return { host: match[1], port: Number.parseInt(match[2] ?? "", 10) };
};

// Parse an exported FortiClient configuration into connections the add form can be filled from. A file with no
// recognisable connections yields an empty list rather than throwing, "nothing to import" is a fair answer for
// a partial export, and the route reports it as such.
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
        // The endpoint and mode live in <ike_settings>; narrowing to it keeps <ipsec_settings>'s own
        // proposals/networks from being read as phase-1 fields.
        const ike = new RegExp(`<ike_settings\\s*>([\\s\\S]*?)</ike_settings>`, "i").exec(block)?.[1] ?? block;
        const server = tagText(ike, "server");
        if (label === undefined || label === "" || server === undefined || server === "") {
            return;
        }
        const { host, port } = splitServer(server, 500);
        // The XAuth username is nested in <xauth>; reading it from the whole block would risk picking up an
        // unrelated <username>.
        const xauth = new RegExp(`<xauth\\s*>([\\s\\S]*?)</xauth>`, "i").exec(ike)?.[1] ?? "";
        const username = plainText(xauth, "username");
        const localId = plainText(ike, "localid");
        const xauthEnabled = tagText(xauth, "enabled") === "1";
        // PFS and the DH group come from <ipsec_settings> (phase 2), NOT <ike_settings>: phase 2 is what the
        // gateway binds, and <ike_settings> often lists several groups ("5;14;") which say nothing about which
        // one quick mode must use.
        const phase2 = new RegExp(`<ipsec_settings\\s*>([\\s\\S]*?)</ipsec_settings>`, "i").exec(block)?.[1] ?? "";
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
            // The pre-shared key is always EncX-wrapped in an export, so it is always something to type.
            needs: ["presharedKey", ...(xauthEnabled && username === undefined ? ["username"] : []), ...(xauthEnabled ? ["password"] : [])],
        });
    });

    return connections;
};
