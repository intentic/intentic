import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8 } from "./canonical.js";
import { generateKeySet, generateRecoveryKey, type RandomBytes, type S2sKeySet, type S2sRecoveryKey } from "./keys.js";

// Test fixtures for the s2s primitives: randomness a test can name, so a key set, a nonce or an envelope id is the same
// on every run and a test can assert it by value. Never for anything that ships.

// SHA-256 in counter mode over the seed: the same bytes for the same seed, every run.
export const seededRandom = (seed: string): RandomBytes => {
    let counter = 0;
    return (length) => {
        const blocks: Uint8Array[] = [];
        for (let made = 0; made < length; made += 32) {
            blocks.push(sha256(concatBytes(utf8(seed), utf8(`:${counter++}`))));
        }
        return concatBytes(...blocks).slice(0, length);
    };
};

// A key set, or a recovery key, that is the same for the same name.
export const keySetFor = (name: string): S2sKeySet => generateKeySet(seededRandom(`key set ${name}`));
export const recoveryKeyFor = (name: string): S2sRecoveryKey => generateRecoveryKey(seededRandom(`recovery ${name}`));
