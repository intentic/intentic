// The browser's sha256 hex over utf8 bytes (WebCrypto — node's is the contract's tunnel-ids.ts). Two consumers,
// both defined by agreeing with a node-side digest byte-for-byte: the guarded save, where it matches the daemon's
// `sha256Text` (workspace-files.ts) so "hashes equal" means exactly "the text I read is still on disk"; and
// sandboxIdFromToken (../sandbox), which mirrors the CLI's token→id derivation.
export const sha256Hex = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, `0`)).join(``);
};
