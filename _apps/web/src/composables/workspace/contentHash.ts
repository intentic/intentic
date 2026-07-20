// The browser half of the guarded save: sha256 hex over the text's utf8 bytes, matching the daemon's
// `sha256Text` (workspace-files.ts) byte-for-byte — both sides hash the utf8-DECODED text the browser read from
// /workspace/file, so "hashes equal" means exactly "the text I read is still on disk".
export const sha256Hex = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, `0`)).join(``);
};
