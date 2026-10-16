import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { RELEASE_PUBLIC_KEY, SIGNED_SUMS_FROM, signatureRequired, sumsEntry, verifyReleaseFiles, type FetchAsset } from "./release-verify.js";

// What an agent checks a downloaded release binary against before it replaces anything (release-verify.ts).

// A release key of the test's own, and a release made with it: SHA256SUMS over the given files, signed the way
// release-checksums.mjs signs it (Tauri's signer: prehashed, base64, file and version in the trusted comment).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY_ID = randomBytes(8);
const PUBLIC_KEY = Buffer.from(
    `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), KEY_ID, Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url")]).toString("base64")}\n`,
).toString("base64");

const signSums = (sums: Buffer, version: string): string => {
    const signature = sign(null, createHash("blake2b512").update(sums).digest(), privateKey);
    const comment = `timestamp:1792100025\tfile:SHA256SUMS\tversion:${version}`;
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from("ED"), KEY_ID, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
    return Buffer.from(text).toString("base64");
};

const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

const AGENT = "intentic-machine-linux-amd64";
const IC = "ic-linux-amd64";

interface Release {
    readonly sums?: string;
    readonly signature?: string;
}

// A release as the fetch sees it: an asset is its bytes, anything else is a 404. Records what was asked for.
const serving = (version: string, release: Release) => {
    const asked: string[] = [];
    const fetchOne: FetchAsset = async (url) => {
        asked.push(url);
        const name = url.slice(url.lastIndexOf("/") + 1);
        expect(url).toBe(`https://github.com/intentic/intentic/releases/download/v${version}/${name}`);
        const body = name === "SHA256SUMS" ? release.sums : name === "SHA256SUMS.sig" ? release.signature : undefined;
        return await Promise.resolve(body === undefined ? undefined : new Uint8Array(Buffer.from(body)));
    };
    return { asked, fetchOne };
};

const download = (contents: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), "release-verify-")), "download");
    writeFileSync(path, contents);
    return path;
};

const agentBytes = "the agent's bytes";
const icBytes = "ic's bytes";
const sumsOf = (lines: Record<string, string>): string =>
    Object.entries(lines)
        .map(([name, bytes]) => `${sha256(bytes)}  ./${name}\n`)
        .join("");
const SUMS = sumsOf({ [AGENT]: agentBytes, [IC]: icBytes, "Intentic-1.340.0-x64-setup.exe": "installer" });

describe("verifyReleaseFiles", () => {
    const version = "1.340.0";

    it("accepts files whose SHA-256 the release's signed SHA256SUMS lists", async () => {
        const { fetchOne } = serving(version, { sums: SUMS, signature: signSums(Buffer.from(SUMS), version) });
        const files = [
            { name: AGENT, path: download(agentBytes) },
            { name: IC, path: download(icBytes) },
        ];
        expect(await verifyReleaseFiles(version, files, fetchOne, PUBLIC_KEY)).toBe("signed");
    });

    it("refuses a file that is not the one listed", async () => {
        const { fetchOne } = serving(version, { sums: SUMS, signature: signSums(Buffer.from(SUMS), version) });
        await expect(verifyReleaseFiles(version, [{ name: AGENT, path: download("something else") }], fetchOne, PUBLIC_KEY)).rejects.toThrow(
            `the downloaded ${AGENT} is not the one v${version} published`,
        );
    });

    it("refuses sums whose signature is not the release key's, or is another release's", async () => {
        const forged = sumsOf({ [AGENT]: "something else" });
        const reused = serving(version, { sums: forged, signature: signSums(Buffer.from(SUMS), version) });
        await expect(verifyReleaseFiles(version, [{ name: AGENT, path: download("something else") }], reused.fetchOne, PUBLIC_KEY)).rejects.toThrow(
            "not signed by the release key: the signature does not match the file",
        );
        const older = serving(version, { sums: SUMS, signature: signSums(Buffer.from(SUMS), "1.339.0") });
        await expect(verifyReleaseFiles(version, [{ name: AGENT, path: download(agentBytes) }], older.fetchOne, PUBLIC_KEY)).rejects.toThrow(
            "for release 1.339.0, not 1.340.0",
        );
        // The built-in key did not sign this test's release.
        const { fetchOne } = serving(version, { sums: SUMS, signature: signSums(Buffer.from(SUMS), version) });
        await expect(verifyReleaseFiles(version, [{ name: AGENT, path: download(agentBytes) }], fetchOne)).rejects.toThrow(
            "not the release key F384CE6F888FF96A",
        );
    });

    it(`requires the signature from v${SIGNED_SUMS_FROM} on`, async () => {
        const { fetchOne } = serving(version, { sums: SUMS });
        await expect(verifyReleaseFiles(version, [{ name: AGENT, path: download(agentBytes) }], fetchOne, PUBLIC_KEY)).rejects.toThrow(
            `release v${version} carries no SHA256SUMS.sig`,
        );
    });

    it("takes the sums of a release from before signing as they are, and still checks a signature that is there", async () => {
        const old = "1.337.0";
        const { fetchOne } = serving(old, { sums: SUMS });
        expect(await verifyReleaseFiles(old, [{ name: AGENT, path: download(agentBytes) }], fetchOne, PUBLIC_KEY)).toBe("unsigned");
        const signedAnyway = serving(old, { sums: SUMS, signature: signSums(Buffer.from(SUMS), "1.336.0") });
        await expect(verifyReleaseFiles(old, [{ name: AGENT, path: download(agentBytes) }], signedAnyway.fetchOne, PUBLIC_KEY)).rejects.toThrow(
            "not 1.337.0",
        );
    });

    // Releases before the floor listed only the desktop installers, so an agent from one has nothing to match.
    it("refuses a file the sums do not list, and a release with no sums at all", async () => {
        const desktopOnly = sumsOf({ "Intentic-1.337.0-x64-setup.exe": "installer" });
        const old = serving("1.337.0", { sums: desktopOnly });
        await expect(verifyReleaseFiles("1.337.0", [{ name: AGENT, path: download(agentBytes) }], old.fetchOne, PUBLIC_KEY)).rejects.toThrow(
            `the SHA256SUMS of v1.337.0 lists no ${AGENT}`,
        );
        const none = serving(version, {});
        await expect(verifyReleaseFiles(version, [{ name: AGENT, path: download(agentBytes) }], none.fetchOne, PUBLIC_KEY)).rejects.toThrow(
            "publishes no SHA256SUMS",
        );
    });

    it("says which file could not be read when the release does not answer", async () => {
        const offline: FetchAsset = async () => await Promise.reject(new Error("fetch failed"));
        await expect(verifyReleaseFiles(version, [{ name: AGENT, path: download(agentBytes) }], offline, PUBLIC_KEY)).rejects.toThrow(
            "could not read SHA256SUMS of v1.340.0 (fetch failed)",
        );
    });
});

describe("the sums file", () => {
    it("is read in sha256sum's text and binary forms, with or without ./", () => {
        const sums = [`${"A".repeat(64)}  ./${AGENT}`, `${"b".repeat(64)} *${IC}`, `${"c".repeat(64)}  latest.json`].join("\r\n");
        expect(sumsEntry(sums, AGENT)).toBe("a".repeat(64));
        expect(sumsEntry(sums, IC)).toBe("b".repeat(64));
        expect(sumsEntry(sums, "latest.json")).toBe("c".repeat(64));
        expect(sumsEntry(sums, "ic-darwin-arm64")).toBeUndefined();
        expect(sumsEntry(`not-a-digest  ./${AGENT}`, AGENT)).toBeUndefined();
    });

    it(`must be signed from v${SIGNED_SUMS_FROM} on, and need not be before`, () => {
        expect(signatureRequired(SIGNED_SUMS_FROM)).toBe(true);
        expect(signatureRequired("2.0.0")).toBe(true);
        expect(signatureRequired("1.337.0")).toBe(false);
    });
});

// The agent's key and the updater's are one key: a rotation that moved only one would leave every agent refusing every
// release, or trusting one the desktop app does not.
test("the release key is the desktop updater's", () => {
    const config = readFileSync(join(repoRoot(import.meta.url), "_editor/desktop-app/src-tauri/tauri.conf.json"), "utf8");
    expect(/"pubkey":\s*"([^"]+)"/.exec(config)?.[1]).toBe(RELEASE_PUBLIC_KEY);
});
