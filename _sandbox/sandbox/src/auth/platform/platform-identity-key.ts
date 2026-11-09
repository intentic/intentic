import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serialLock } from "@intentic/base/async";
import { isMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import type { Logger } from "pino";

// The public half of the key the platform signs identity assertions with (sandbox-contract policy/identity-assertion.ts).
// A hosted machine is handed it in its env (PLATFORM_IDENTITY_KEY), since it boots before it first announces; every
// sandbox then learns the newest from each announce answer, so one started by any `ic` has it within seconds of its
// first announce and follows a rotation within the hour.
// (2026-11-09) The newest key an announce taught is kept on /history too, and read back at boot when the env names none:
// a sandbox restarted while the platform was down otherwise refused every email-code sign-in (PLATFORM_KEY_UNKNOWN after
// the sign-in's wait), though the browser held an assertion signed before the outage. The env still wins at boot, and
// a newer announce replaces the file. Rejected: keeping it in memory only, on the reasoning that a daemon which cannot
// reach the platform has no assertion to verify; the browser asks the platform for the assertion, not the daemon.
export interface PlatformIdentityKey {
    readonly current: () => string | undefined;
    // Takes a key the platform announced; one that is not an Ed25519 public key is ignored, keeping the last good one.
    readonly learn: (pem: string) => void;
    // The key, waiting up to `waitMs` for the first one when none is known yet.
    readonly settled: (waitMs: number) => Promise<string | undefined>;
}

// Where the newest announced key is kept between restarts.
export interface StoredIdentityKey {
    // Undefined when nothing was kept.
    readonly read: () => Promise<string | undefined>;
    readonly write: (pem: string) => Promise<void>;
}

// A plain file rather than a converted document: one PEM, written whole, whose format its standard fixes rather than this
// build, like session-secret beside it. 0644: a public key.
export const fileIdentityKey = (historyRoot: string): StoredIdentityKey => {
    // Spelled where it is joined, as every /history path is, so the state table's coverage test sees it built.
    const path = join(historyRoot, "platform-identity-key.pem");
    return {
        read: async () => {
            try {
                return await readFile(path, "utf8");
            } catch (error) {
                if (isMissing(error)) {
                    return undefined;
                }
                throw error;
            }
        },
        write: (pem) => writeFileAtomic(path, pem, 0o644),
    };
};

const isEd25519PublicKey = (pem: string): boolean => {
    try {
        return createPublicKey(pem).asymmetricKeyType === "ed25519";
    } catch {
        // allow(silent-catch): text that does not parse as a key is the answer itself, not a fault: it is no key of ours.
        return false;
    }
};

export interface PlatformIdentityKeyOptions {
    readonly stored?: StoredIdentityKey;
    // Says a kept key that could not be read or written; neither stops the daemon, which learns the key again from the
    // next announce.
    readonly logger?: Pick<Logger, "warn">;
}

export const createPlatformIdentityKey = (initial: string, { stored, logger }: PlatformIdentityKeyOptions = {}): PlatformIdentityKey => {
    let key = initial !== "" && isEd25519PublicKey(initial) ? initial : undefined;
    let waiters: Array<(learned: string) => void> = [];
    // The key the file holds, as far as this process knows: an announce naming it again writes nothing.
    let kept: string | undefined;
    // One write at a time, in the order the keys were learned, so a rotation's older key never lands last.
    const writes = serialLock();
    const take = (pem: string): void => {
        key = pem;
        const woken = waiters;
        waiters = [];
        for (const wake of woken) {
            wake(pem);
        }
    };
    // Read once at boot, and only when the env named none: a key learned meanwhile is newer, and stays.
    if (key === undefined && stored !== undefined) {
        void stored.read().then(
            (pem) => {
                kept ??= pem;
                if (key === undefined && pem !== undefined && isEd25519PublicKey(pem)) {
                    take(pem);
                }
            },
            (error: Error) => logger?.warn({ err: error }, "the platform's identity key kept on /history could not be read"),
        );
    }
    return {
        current: () => key,
        learn: (pem) => {
            if (!isEd25519PublicKey(pem)) {
                return;
            }
            if (pem !== key) {
                take(pem);
            }
            if (stored !== undefined && pem !== kept) {
                kept = pem;
                void writes(() => stored.write(pem)).catch((error: Error) => logger?.warn({ err: error }, "the platform's identity key was not kept on /history"));
            }
        },
        settled: (waitMs) => {
            if (key !== undefined || waitMs <= 0) {
                return Promise.resolve(key);
            }
            return new Promise((resolve) => {
                const wake = (learned: string): void => {
                    clearTimeout(timer);
                    resolve(learned);
                };
                const timer = setTimeout(() => {
                    waiters = waiters.filter((waiter) => waiter !== wake);
                    resolve(key);
                }, waitMs);
                waiters.push(wake);
            });
        },
    };
};
