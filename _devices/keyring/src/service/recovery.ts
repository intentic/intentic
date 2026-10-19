import { randomBytes } from "node:crypto";

// THE RECOVERY KEY (2026-10-19): what opens the vault when Windows Hello is reset, polkit cannot ask, or the computer is
// replaced. Made by the computer at setup instead of a passphrase a person invents, shown once, and never stored: the
// vault keeps only its scrypt wrap, exactly as it kept the passphrase's (vault.ts), and the setup op still names the field
// `passphrase`. Six groups of five Crockford base32 characters: 150 bits, read aloud and typed without ambiguity.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUPS = 6;
const GROUP_LENGTH = 5;
const LENGTH = GROUPS * GROUP_LENGTH;

const grouped = (characters: string): string => Array.from({ length: GROUPS }, (_unused, index) => characters.slice(index * GROUP_LENGTH, (index + 1) * GROUP_LENGTH)).join("-");

/** A fresh recovery key, `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. */
export const newRecoveryKey = (random: (size: number) => Buffer = randomBytes): string => {
    // One byte per character, its low five bits: 256 is a multiple of 32, so every character is equally likely.
    const bytes = random(LENGTH);
    return grouped(Array.from(bytes, (byte) => CROCKFORD[byte & 31] ?? "0").join(""));
};

/**
 * What a person typed, as the recovery key it was meant to be: case, spaces and dashes ignored, and the letters Crockford
 * reads as digits (I and L as 1, O as 0) read so. Anything else, a passphrase from before recovery keys among them, is
 * given back exactly as typed, so the vault still opens with it.
 */
export const asRecoveryKey = (typed: string): string => {
    const bare = typed
        .toUpperCase()
        .replace(/[\s-]/gu, "")
        .replace(/[IL]/gu, "1")
        .replace(/O/gu, "0");
    if (bare.length !== LENGTH || [...bare].some((character) => !CROCKFORD.includes(character))) {
        return typed;
    }
    return grouped(bare);
};
