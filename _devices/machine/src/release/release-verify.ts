import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { errorMessage } from "@intentic/base/errors";
import { isNewer } from "@intentic/sandbox-contract/state/versions";
import { releaseAssetUrl } from "../release.js";
import { verifySignedSums } from "./release-signature.js";

// WHAT A DOWNLOADED RELEASE BINARY IS CHECKED AGAINST BEFORE IT REPLACES ANYTHING: the agent's own upgrade
// (upgrade.ts), the launcher beside it on Windows (install.ts), and the ic it keeps current (device/tools/ic-binary.ts).
// The release publishes SHA256SUMS over every asset it attaches, and SHA256SUMS.sig, the release key's minisign
// signature over it (release-checksums.mjs). The sums are believed only once the signature checks out against the key
// built in here, and then the file's own SHA-256 must be the one they list. Anything short of that keeps the binary
// the machine has.

/**
 * The release key: the desktop updater's minisign public key, exactly as `plugins.updater.pubkey` in
 * _editor/desktop-app/src-tauri/tauri.conf.json spells it (Tauri's base64 of the key file), held equal to it by a test.
 * Key id F384CE6F888FF96A. Rotating it means a release signed by both, since agents in the field know only this one.
 */
export const RELEASE_PUBLIC_KEY =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEYzODRDRTZGODg4RkY5NkEKUldScStZK0liODZFODh5UWRTdmhLaCsyK09PS3dlV25XUUdQa0hiY1lUR2NGSGI3Smxaby9zRzYK";

/**
 * The first release whose SHA256SUMS is signed and lists the agent and ic binaries. From it on a release without
 * SHA256SUMS.sig is refused. An older one has no signature to check, so its sums are taken as they come, and since
 * they list only the desktop installers, an agent or ic from before it does not verify at all: nothing moves onto one.
 * Upgrades only go forward, and ic is fetched at the agent's own release, so nothing that runs this asks for one.
 */
export const SIGNED_SUMS_FROM = "1.338.0";

/** Whether a release must carry SHA256SUMS.sig. */
export const signatureRequired = (version: string): boolean => !isNewer(SIGNED_SUMS_FROM, version);

/** The SHA-256 a SHA256SUMS file lists for `name`, in lower case, or undefined when it lists no such file. */
export const sumsEntry = (sumsText: string, name: string): string | undefined => {
    for (const line of sumsText.split(/\r?\n/)) {
        const match = /^([0-9a-fA-F]{64}) [ *](?:\.\/)?(.+)$/.exec(line.trim());
        if (match?.[2] === name) {
            return match[1]?.toLowerCase();
        }
    }
    return undefined;
};

const fileSha256 = async (path: string): Promise<string> => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest("hex");
};

/** A release asset's bytes, or undefined when the release has no such asset (404). Throws on anything else. */
export type FetchAsset = (url: string) => Promise<Uint8Array | undefined>;

const fetchAsset: FetchAsset = async (url) => {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
};

/** A downloaded file and the release asset it is meant to be. */
export interface ReleaseFile {
    readonly name: string;
    readonly path: string;
}

const read = async (fetchOne: FetchAsset, version: string, name: string): Promise<Uint8Array | undefined> => {
    try {
        return await fetchOne(releaseAssetUrl(version, name));
    } catch (error) {
        throw new Error(`could not read ${name} of v${version} (${errorMessage(error)})`, { cause: error });
    }
};

/**
 * Throws, saying why, unless every file is what release `version` published under its name: SHA256SUMS signed by the
 * release key for this version (required from SIGNED_SUMS_FROM on, and checked whenever present), listing each file
 * with its SHA-256. Answers whether the sums were signed.
 */
export const verifyReleaseFiles = async (
    version: string,
    files: readonly ReleaseFile[],
    fetchOne: FetchAsset = fetchAsset,
    publicKey: string = RELEASE_PUBLIC_KEY,
): Promise<"signed" | "unsigned"> => {
    const sums = await read(fetchOne, version, "SHA256SUMS");
    if (sums === undefined) {
        throw new Error(`release v${version} publishes no SHA256SUMS to check the download against`);
    }
    const signature = await read(fetchOne, version, "SHA256SUMS.sig");
    if (signature !== undefined) {
        try {
            verifySignedSums(sums, Buffer.from(signature).toString("utf8"), publicKey, version);
        } catch (error) {
            throw new Error(`the SHA256SUMS of v${version} is not signed by the release key: ${errorMessage(error)}`, { cause: error });
        }
    } else if (signatureRequired(version)) {
        throw new Error(`release v${version} carries no SHA256SUMS.sig, and every release from v${SIGNED_SUMS_FROM} on is signed`);
    }
    const text = Buffer.from(sums).toString("utf8");
    for (const file of files) {
        const expected = sumsEntry(text, file.name);
        if (expected === undefined) {
            throw new Error(`the SHA256SUMS of v${version} lists no ${file.name}`);
        }
        // one file at a time; there are at most two
        const actual = await fileSha256(file.path);
        if (actual !== expected) {
            throw new Error(`the downloaded ${file.name} is not the one v${version} published (SHA-256 ${actual}, its SHA256SUMS says ${expected})`);
        }
    }
    return signature === undefined ? "unsigned" : "signed";
};
