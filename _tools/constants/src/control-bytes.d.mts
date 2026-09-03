// Types for control-bytes.mjs, the byte-level text invariant every control-character reader shares.
export const BINARY_EXTENSIONS: ReadonlySet<string>;
export function isBinaryPath(path: string): boolean;
export function isForbiddenByte(byte: number): boolean;
export function firstForbiddenByte(bytes: Uint8Array): { readonly offset: number; readonly line: number; readonly column: number; readonly byte: number } | undefined;
export function byteName(byte: number): string;
export function escapeFor(byte: number): string;
