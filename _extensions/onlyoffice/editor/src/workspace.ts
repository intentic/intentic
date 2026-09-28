// SPDX-License-Identifier: AGPL-3.0-only
import type { WriteKind, WriteOutcome } from "./save.js";

// The page's two ways out for exported bytes: into the workspace file through the listener, or to the browser as a
// download the reader asked for.

interface WriteAnswer {
    readonly path?: string;
    readonly version?: string;
}

// Writes `bytes` to the document through the listener: a save names the version it replaces, and a file changed on
// disk meanwhile answers 409, which is the conflict the owner settles.
export const writeDocument = async (fileUrl: string, bytes: ArrayBuffer, kind: WriteKind): Promise<WriteOutcome> => {
    const url = new URL(fileUrl, window.location.href);
    if (kind.kind !== `save`) {
        url.searchParams.set(`write`, kind.kind);
    }
    const headers = new Headers();
    if (kind.kind === `save`) {
        headers.set(`if-match`, `"${kind.expected}"`);
    }
    try {
        const response = await fetch(url, { method: `PUT`, body: bytes, cache: `no-store`, headers });
        if (response.status === 409) {
            return { conflict: true };
        }
        if (!response.ok) {
            return { failed: `the sandbox answered ${response.status}: ${await response.text()}` };
        }
        // SAFETY: the listener's own answer to a write; both fields are checked before they are used.
        const answer = (await response.json()) as WriteAnswer;
        return answer.path !== undefined && answer.version !== undefined
            ? { written: true, path: answer.path, version: answer.version }
            : { failed: `the sandbox's answer to the save was not understood` };
    } catch (error) {
        return { failed: error instanceof Error ? error.message : String(error) };
    }
};

// Hands `bytes` to the browser as a download named `fileName`.
export const downloadFile = (bytes: ArrayBuffer, fileName: string): void => {
    const link = document.createElement(`a`);
    link.href = URL.createObjectURL(new Blob([bytes]));
    link.download = fileName;
    document.body.append(link);
    link.click();
    setTimeout(() => {
        URL.revokeObjectURL(link.href);
        link.remove();
    }, 1000);
};
