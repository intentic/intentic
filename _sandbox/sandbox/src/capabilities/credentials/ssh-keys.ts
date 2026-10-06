import { generateKeyPairSync, randomBytes } from "node:crypto";
import ssh2, { type ParsedKey } from "ssh2";

// An SSH key the sandbox makes for a connection, so the person setting it up never handles a private key. ed25519,
// written in OpenSSH's own container (PROTOCOL.key in the OpenSSH sources) by hand: node:crypto speaks PEM and JWK but
// not that, and ssh-keygen only writes files, while this key must exist in memory alone until an add stores it.

export interface SshKeyPair {
    // The one line a server's authorized_keys holds: `ssh-ed25519 <base64 blob> <comment>`.
    readonly publicKey: string;
    // Unencrypted and armored, exactly as `ssh-keygen -N ''` would write it.
    readonly privateKey: string;
}

const KEY_TYPE = "ssh-ed25519";
const MAGIC = Buffer.from("openssh-key-v1\0", "latin1");
const ARMOR_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const ARMOR_END = "-----END OPENSSH PRIVATE KEY-----";
// The cipher block size the private section pads to; "none" counts as 8.
const BLOCK = 8;

// The SSH wire encoding (RFC 4251): a big-endian uint32, and a string as that length followed by its bytes.
const uint32 = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
};
const wireString = (value: string | Buffer): Buffer => {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    return Buffer.concat([uint32(bytes.length), bytes]);
};

// What a server admin reads in authorized_keys to know whose key it is. Only [A-Za-z0-9._-] survive, so the line can
// sit inside the single quotes of the command that authorizes it.
export const keyComment = (sandboxName: string): string => {
    const slug = sandboxName
        .trim()
        .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
        .replaceAll(/-{2,}/g, "-")
        .replaceAll(/^-+|-+$/g, "");
    return slug === "" ? "intentic" : `intentic-${slug}`;
};

export const generateSshKey = (comment: string): SshKeyPair => {
    const pair = generateKeyPairSync("ed25519");
    const publicPoint = Buffer.from(pair.publicKey.export({ format: "jwk" }).x ?? "", "base64url");
    const seed = Buffer.from(pair.privateKey.export({ format: "jwk" }).d ?? "", "base64url");
    const blob = Buffer.concat([wireString(KEY_TYPE), wireString(publicPoint)]);
    // Two equal check words, which is how a reader tells a right passphrase from a wrong one; unencrypted they only match.
    const check = randomBytes(4);
    const section = Buffer.concat([
        check,
        check,
        wireString(KEY_TYPE),
        wireString(publicPoint),
        // OpenSSH's ed25519 private key is the seed followed by the public point.
        wireString(Buffer.concat([seed, publicPoint])),
        wireString(comment),
    ]);
    const padding = Buffer.from(Array.from({ length: (BLOCK - (section.length % BLOCK)) % BLOCK }, (_, index) => index + 1));
    const body = Buffer.concat([
        MAGIC,
        wireString("none"),
        wireString("none"),
        wireString(""),
        uint32(1),
        wireString(blob),
        wireString(Buffer.concat([section, padding])),
    ]);
    const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
    return {
        publicKey: `${KEY_TYPE} ${blob.toString("base64")} ${comment}`,
        privateKey: `${ARMOR_BEGIN}\n${lines.join("\n")}\n${ARMOR_END}\n`,
    };
};

// Reads wire values front to back; undefined once past the end, so a truncated key reads as no key rather than throwing.
const wireReader = (bytes: Buffer) => {
    let offset = 0;
    const take = (length: number): Buffer | undefined => {
        if (offset + length > bytes.length) {
            return undefined;
        }
        offset += length;
        return bytes.subarray(offset - length, offset);
    };
    const count = (): number | undefined => take(4)?.readUInt32BE(0);
    const string = (): Buffer | undefined => {
        const length = count();
        return length === undefined ? undefined : take(length);
    };
    return { take, count, string };
};

// The comment sits in the private section, after fields whose layout depends on the key type; only an unencrypted
// ed25519 section (every key generateSshKey makes) is read for it.
const ed25519Comment = (section: Buffer | undefined): string | undefined => {
    if (section === undefined) {
        return undefined;
    }
    const read = wireReader(section);
    read.take(8);
    read.string();
    read.string();
    read.string();
    return read.string()?.toString("utf8");
};

// The public line of an OpenSSH private key, read off its header, which OpenSSH leaves unencrypted even on a key that
// has a passphrase: what an edit form shows to authorize again. Undefined for anything else (a PEM key, a marker).
export const publicKeyOf = (privateKey: string): string | undefined => {
    const start = privateKey.indexOf(ARMOR_BEGIN);
    const end = privateKey.indexOf(ARMOR_END);
    if (start === -1 || end < start) {
        return undefined;
    }
    const body = Buffer.from(privateKey.slice(start + ARMOR_BEGIN.length, end).replaceAll(/\s/g, ""), "base64");
    if (!body.subarray(0, MAGIC.length).equals(MAGIC)) {
        return undefined;
    }
    const read = wireReader(body.subarray(MAGIC.length));
    const cipher = read.string()?.toString("latin1");
    read.string();
    read.string();
    const blob = read.count() === 1 ? read.string() : undefined;
    const type = blob === undefined ? undefined : wireReader(blob).string()?.toString("latin1");
    if (cipher === undefined || blob === undefined || type === undefined || type === "") {
        return undefined;
    }
    const comment = cipher === "none" && type === KEY_TYPE ? ed25519Comment(read.string()) : undefined;
    return [type, blob.toString("base64"), comment].filter((part) => part !== undefined && part !== "").join(" ");
};

// A private key the sandbox's ssh agent can sign with: unencrypted, in any format OpenSSH loads (its own container, PEM
// or PKCS#8). Undefined for anything else, a key with a passphrase included: nothing here could ever type one.
// ssh2 is CommonJS, and node's ESM loader finds no named `utils` export in it (bun does), so it is read off the default.
export const loadPrivateKey = (privateKey: string): ParsedKey | undefined => {
    const parsed: ParsedKey | ParsedKey[] | Error = ssh2.utils.parseKey(privateKey);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    return key === undefined || key instanceof Error || !key.isPrivateKey() ? undefined : key;
};

// The authorized_keys line of a key the agent can sign with; undefined when loadPrivateKey cannot read it.
export const publicLineOf = (privateKey: string): string | undefined => {
    const key = loadPrivateKey(privateKey);
    if (key === undefined) {
        return undefined;
    }
    return [key.type, key.getPublicSSH().toString("base64"), key.comment].filter((part) => part !== "").join(" ");
};
