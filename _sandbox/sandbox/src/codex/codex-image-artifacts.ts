import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { statePath } from "../workspace/state-paths.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface CodexImageResult {
    readonly id: string;
    readonly result: string;
    readonly saved_path?: string;
}

const codexImageOutputDir = (workspaceRoot: string): string => statePath(workspaceRoot, ".intentic/artifacts/", "imagegen");

const safeFilename = (id: string): string => {
    const safe = id
        .slice(0, 128)
        .split("")
        .map((character) => (/[A-Za-z0-9_-]/.test(character) ? character : "_"))
        .join("");
    return safe === "" ? "generated_image" : safe;
};

const isInside = (root: string, path: string): boolean => {
    const fromRoot = relative(root, path);
    return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
};

const savedImage = async (codexHome: string, path: string): Promise<Buffer> => {
    if (!isAbsolute(path)) {
        throw new Error("Codex image artifact path is not absolute");
    }
    const generatedDir = `${codexHome}${sep}generated_images`;
    // Reject an arbitrary absolute path before opening it. The descriptor check below remains necessary because
    // an intermediate symlink inside generated_images can make a lexically-contained name resolve elsewhere.
    if (!isInside(resolve(generatedDir), resolve(path))) {
        throw new Error("Codex image artifact is outside CODEX_HOME/generated_images");
    }
    const namedMetadata = await lstat(path);
    if (namedMetadata.isSymbolicLink()) {
        throw new Error("Codex image artifact must not be a symbolic link");
    }
    if (!namedMetadata.isFile()) {
        throw new Error("Codex image artifact is not a regular file");
    }

    const generatedRoot = await realpath(generatedDir);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        // Resolve the opened descriptor, not the name checked above: this closes the replace/symlink race between
        // validation and read while still allowing Codex's own nested thread directory under generated_images.
        const openedPath = await realpath(`/proc/self/fd/${file.fd}`);
        if (!isInside(generatedRoot, openedPath)) {
            throw new Error("Codex image artifact is outside CODEX_HOME/generated_images");
        }
        const metadata = await file.stat();
        if (!metadata.isFile()) {
            throw new Error("Codex image artifact is not a regular file");
        }
        if (metadata.size > MAX_IMAGE_BYTES) {
            throw new Error("Codex image artifact exceeds 32 MiB");
        }
        // Read at most the observed size plus one byte. A provider path that grows after stat can then fail the
        // invariant without making readFile allocate whatever size an attacker races it to.
        const buffer = Buffer.allocUnsafe(metadata.size + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== metadata.size) {
            throw new Error("Codex image artifact changed while it was being read");
        }
        return buffer.subarray(0, bytesRead);
    } finally {
        await file.close();
    }
};

const decodedImage = (result: string): Buffer => {
    const encoded = result.trim();
    const padding = encoded.indexOf("=");
    if (encoded === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1 || (padding !== -1 && encoded.length % 4 !== 0)) {
        throw new Error("Codex image result is not valid base64");
    }
    const paddingBytes = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    if (Math.floor((encoded.length * 3) / 4) - paddingBytes > MAX_IMAGE_BYTES) {
        throw new Error("Codex image artifact exceeds 32 MiB");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
        throw new Error("Codex image result is not valid base64");
    }
    return bytes;
};

const assertPng = (bytes: Buffer): void => {
    if (bytes.length > MAX_IMAGE_BYTES) {
        throw new Error("Codex image artifact exceeds 32 MiB");
    }
    if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error("Codex image artifact is not a PNG");
    }
};

// Codex keeps its own generated image as provider state. Intentic copies the bytes into carried workspace state:
// transcripts can then retain one small path while /workspace/raw serves the durable picture after the CLI exits.
export const persistCodexImageArtifact = async (options: {
    readonly workspaceRoot: string;
    readonly codexHome: string;
    readonly image: CodexImageResult;
}): Promise<string> => {
    const bytes =
        options.image.saved_path === undefined ? decodedImage(options.image.result) : await savedImage(options.codexHome, options.image.saved_path);
    assertPng(bytes);

    const outputDir = codexImageOutputDir(options.workspaceRoot);
    await mkdir(outputDir, { recursive: true });
    const realWorkspaceRoot = await realpath(options.workspaceRoot);
    const realOutputDir = await realpath(outputDir);
    if (!isInside(realWorkspaceRoot, realOutputDir)) {
        throw new Error("Codex image output directory is outside the workspace");
    }
    const filename = `${safeFilename(options.image.id)}.png`;
    const output = `${realOutputDir}${sep}${filename}`;
    const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
        await file.writeFile(bytes);
    } finally {
        await file.close();
    }
    return relative(options.workspaceRoot, `${outputDir}${sep}${filename}`).split(sep).join("/");
};
