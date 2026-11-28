import { consistencyProof, EMPTY_ROOT, inclusionProof, leafHash, rootOf, toHex, verifyConsistency, verifyInclusion } from "./merkle.js";

// The eight leaves and roots of Certificate Transparency's reference tests (certificate-transparency-go
// merkletree/merkle_tree_test.go, and RFC 6962's own Merkle tree as Trillian tests it): leaf i's input, and the root
// of the tree over leaves 0..i.
const LEAVES = [``, `00`, `10`, `2021`, `3031`, `40414243`, `5051525354555657`, `606162636465666768696a6b6c6d6e6f`].map((hex) => new Uint8Array(Buffer.from(hex, `hex`)));
const ROOTS = [
    `6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d`,
    `fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125`,
    `aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77`,
    `d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7`,
    `4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4`,
    `76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef`,
    `ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c`,
    `5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328`,
];

const hashed = LEAVES.map((leaf) => leafHash(leaf));
const manyLeaves = (n: number) => Array.from({ length: n }, (_, at) => leafHash(new Uint8Array([at, at >> 8])));

describe(`RFC 6962 Merkle tree`, () => {
    it(`hashes the empty tree to SHA-256 of nothing`, () => {
        expect(toHex(EMPTY_ROOT)).toBe(`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`);
    });

    it.each(ROOTS.map((root, at) => [at + 1, root] as const))(`matches the reference root of a tree of %i`, (size, root) => {
        expect(toHex(rootOf(hashed.slice(0, size)))).toBe(root);
    });

    it(`proves and verifies every leaf's inclusion in every tree up to 33`, () => {
        for (let size = 1; size <= 33; size++) {
            const leaves = manyLeaves(size);
            const root = rootOf(leaves);
            for (let index = 0; index < size; index++) {
                const proof = inclusionProof(index, leaves);
                expect(verifyInclusion(index, size, leaves[index] ?? EMPTY_ROOT, proof, root)).toBe(true);
            }
        }
    });

    it(`refuses an inclusion proof for another leaf, another position or a shortened path`, () => {
        const leaves = manyLeaves(13);
        const root = rootOf(leaves);
        const proof = inclusionProof(5, leaves);
        expect(verifyInclusion(5, 13, leaves[6] ?? EMPTY_ROOT, proof, root)).toBe(false);
        expect(verifyInclusion(4, 13, leaves[5] ?? EMPTY_ROOT, proof, root)).toBe(false);
        expect(verifyInclusion(5, 13, leaves[5] ?? EMPTY_ROOT, proof.slice(1), root)).toBe(false);
    });

    it(`proves and verifies consistency between every pair of sizes up to 33`, () => {
        const leaves = manyLeaves(33);
        for (let newSize = 1; newSize <= 33; newSize++) {
            const newRoot = rootOf(leaves.slice(0, newSize));
            for (let oldSize = 1; oldSize <= newSize; oldSize++) {
                const proof = consistencyProof(oldSize, leaves.slice(0, newSize));
                expect(verifyConsistency(oldSize, newSize, rootOf(leaves.slice(0, oldSize)), newRoot, proof)).toBe(true);
            }
        }
    });

    it(`refuses consistency with a rewritten history`, () => {
        const leaves = manyLeaves(10);
        const forked = [...leaves.slice(0, 3), leafHash(Uint8Array.of(99)), ...leaves.slice(4)];
        const proof = consistencyProof(6, forked);
        expect(verifyConsistency(6, 10, rootOf(leaves.slice(0, 6)), rootOf(forked), proof)).toBe(false);
    });
});
