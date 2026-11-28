import { sha256 } from "@noble/hashes/sha2.js";

/* THE LOG'S TREE: RFC 6962's Merkle hash tree (Certificate Transparency's, section 2.1), the one every transparency
   log since uses (C2SP tlog-*, Sigsum, Go's checksum database). A leaf's hash is SHA-256 over 0x00 and the leaf's bytes,
   a node's over 0x01 and its two children; a tree of n leaves splits at the largest power of two below n. Inclusion and
   consistency proofs, and their verification, follow sections 2.1.1 and 2.1.2. Pure, over bytes: no I/O. */

export type Hash = Uint8Array;

const LEAF_PREFIX = Uint8Array.of(0);
const NODE_PREFIX = Uint8Array.of(1);

const joined = (...parts: readonly Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

export const leafHash = (leaf: Uint8Array): Hash => sha256(joined(LEAF_PREFIX, leaf));
const nodeHash = (left: Hash, right: Hash): Hash => sha256(joined(NODE_PREFIX, left, right));
// The empty tree's root: SHA-256 of nothing.
export const EMPTY_ROOT: Hash = sha256(new Uint8Array(0));

// The largest power of two strictly below n (n > 1).
const splitOf = (n: number): number => {
    let k = 1;
    while (k * 2 < n) {
        k *= 2;
    }
    return k;
};

// The root over leaf hashes (already hashed with `leafHash`).
export const rootOf = (leaves: readonly Hash[]): Hash => {
    if (leaves.length === 0) {
        return EMPTY_ROOT;
    }
    if (leaves.length === 1) {
        return leaves[0] ?? EMPTY_ROOT;
    }
    const k = splitOf(leaves.length);
    return nodeHash(rootOf(leaves.slice(0, k)), rootOf(leaves.slice(k)));
};

// RFC 6962 2.1.1 PATH(m, D[n]): the audit path for leaf m in the tree over `leaves`.
export const inclusionProof = (index: number, leaves: readonly Hash[]): Hash[] => {
    if (index < 0 || index >= leaves.length) {
        throw new RangeError(`leaf ${index} is not in a tree of ${leaves.length}`);
    }
    if (leaves.length === 1) {
        return [];
    }
    const k = splitOf(leaves.length);
    return index < k
        ? [...inclusionProof(index, leaves.slice(0, k)), rootOf(leaves.slice(k))]
        : [...inclusionProof(index - k, leaves.slice(k)), rootOf(leaves.slice(0, k))];
};

// RFC 6962 2.1.2 SUBPROOF(m, D[n], b).
const subproof = (m: number, leaves: readonly Hash[], complete: boolean): Hash[] => {
    const n = leaves.length;
    if (m === n) {
        return complete ? [] : [rootOf(leaves)];
    }
    const k = splitOf(n);
    return m <= k
        ? [...subproof(m, leaves.slice(0, k), complete), rootOf(leaves.slice(k))]
        : [...subproof(m - k, leaves.slice(k), false), rootOf(leaves.slice(0, k))];
};

// PROOF(m, D[n]): that the tree of the first m leaves is a prefix of the tree of all n.
export const consistencyProof = (m: number, leaves: readonly Hash[]): Hash[] => {
    if (m < 0 || m > leaves.length) {
        throw new RangeError(`a tree of ${m} is no prefix of a tree of ${leaves.length}`);
    }
    return m === 0 || m === leaves.length ? [] : subproof(m, leaves, true);
};

const sameHash = (left: Hash, right: Hash): boolean => left.length === right.length && left.every((byte, at) => byte === right[at]);

// RFC 9162 2.1.3.2: the root an inclusion proof leads to from `leaf` at `index` in a tree of `size`, or undefined
// when the proof has the wrong length for that position.
const rootFromInclusion = (index: number, size: number, leaf: Hash, proof: readonly Hash[]): Hash | undefined => {
    if (index < 0 || index >= size) {
        return undefined;
    }
    let fn = index;
    let sn = size - 1;
    let r = leaf;
    for (const p of proof) {
        if (sn === 0) {
            return undefined;
        }
        if (fn % 2 === 1 || fn === sn) {
            r = nodeHash(p, r);
            if (fn % 2 === 0) {
                while (fn % 2 === 0 && fn !== 0) {
                    fn = Math.floor(fn / 2);
                    sn = Math.floor(sn / 2);
                }
            }
        } else {
            r = nodeHash(r, p);
        }
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
    }
    return sn === 0 ? r : undefined;
};

export const verifyInclusion = (index: number, size: number, leaf: Hash, proof: readonly Hash[], root: Hash): boolean => {
    const computed = rootFromInclusion(index, size, leaf, proof);
    return computed !== undefined && sameHash(computed, root);
};

// RFC 9162 2.1.4.2: whether `proof` shows the tree of `oldSize` with `oldRoot` is a prefix of the one of `newSize`.
export const verifyConsistency = (oldSize: number, newSize: number, oldRoot: Hash, newRoot: Hash, proof: readonly Hash[]): boolean => {
    if (oldSize < 0 || oldSize > newSize) {
        return false;
    }
    if (oldSize === newSize) {
        return proof.length === 0 && sameHash(oldRoot, newRoot);
    }
    if (oldSize === 0) {
        return proof.length === 0;
    }
    const path = (oldSize & (oldSize - 1)) === 0 ? [oldRoot, ...proof] : [...proof];
    let fn = oldSize - 1;
    let sn = newSize - 1;
    while (fn % 2 === 1) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
    }
    const [first, ...rest] = path;
    if (first === undefined) {
        return false;
    }
    let fr = first;
    let sr = first;
    for (const c of rest) {
        if (sn === 0) {
            return false;
        }
        if (fn % 2 === 1 || fn === sn) {
            fr = nodeHash(c, fr);
            sr = nodeHash(c, sr);
            while (fn % 2 === 0 && fn !== 0) {
                fn = Math.floor(fn / 2);
                sn = Math.floor(sn / 2);
            }
        } else {
            sr = nodeHash(sr, c);
        }
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
    }
    return sn === 0 && sameHash(fr, oldRoot) && sameHash(sr, newRoot);
};

export const toHex = (hash: Hash): string => Buffer.from(hash).toString(`hex`);
export const toBase64 = (hash: Hash): string => Buffer.from(hash).toString(`base64`);
export const fromBase64 = (text: string): Hash | undefined => {
    const bytes = Buffer.from(text, `base64`);
    return bytes.toString(`base64`) === text ? new Uint8Array(bytes) : undefined;
};
