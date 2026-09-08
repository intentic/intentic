import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { HOST_STATE_ROOT } from "@intentic/constants";
import type { SshExecutor, SshResult, SshTarget } from "@intentic/providers";
import { shellQuote } from "@intentic/sandbox-run/quote";

// Host-side advisory lock serializing apply (and prune) against a host via atomic mkdir test-and-set; lives on the
// host, not a state file. `expiresAt` only hints when a lock may be taken over: verify checks the nonce, not the clock,
// so a stale-TTL takeover never leaves two writers, the overwritten run fails its next verify.
const LOCK_DIR = `${HOST_STATE_ROOT}/apply.lock.d`;
// Generous: an apply can pull images or run a restic restore for minutes. Crash-recovery only.
const DEFAULT_TTL_SECONDS = 30 * 60;

export interface ApplyLock {
    // Throw if any held lock no longer carries our nonce (another run took it over). Call before mutating.
    readonly verify: () => Promise<void>;
    // Push the takeover deadline out on every held lock, for an apply that runs longer than the TTL.
    readonly renew: () => Promise<void>;
    // Best-effort release of every lock held; only removes a lock that still carries our nonce.
    readonly release: () => Promise<void>;
}

const lockKey = (target: SshTarget): string => `${target.address}:${target.port}`;

// Dedupes by address:port and orders deterministically so concurrent runs acquire hosts in the same order, avoiding
// deadlock.
const orderedHosts = (targets: readonly SshTarget[]): SshTarget[] => {
    const byKey = new Map<string, SshTarget>();
    for (const target of targets) {
        byKey.set(lockKey(target), target);
    }
    return [...byKey.values()].toSorted((a, b) => lockKey(a).localeCompare(lockKey(b)));
};

// Identifies the run holding the lock, shown to whoever is blocked; sanitized to a space-free token so it stays one
// shell word.
const defaultHolder = (): string => `${hostname()}:${process.pid}`.replace(/[^A-Za-z0-9_.:@-]/g, "-");

// Each script starts with `#APPLYLOCK <op> <nonce> <ttl>`: a no-op comment on a real shell, a stable parse handle for
// the fake test executor.
const header = (op: string, nonce: string, ttl: number): string => `#APPLYLOCK ${op} ${nonce} ${ttl}\n`;

// `expiresAt` is computed from the host's own clock, not the operator's, avoiding clock skew; POSIX `date +%s` for
// portability.
const acquireScript = (holder: string, nonce: string, ttl: number): string =>
    `${header("acquire", nonce, ttl)}mkdir -p /opt/intentic 2>/dev/null
[ -w /opt/intentic ] || { echo "CANNOT_WRITE /opt/intentic"; exit 1; }
LOCK=${LOCK_DIR}
META=$LOCK/meta.json
write() {
  printf '{"holder":"%s","nonce":"%s","expiresAt":%s}\\n' ${shellQuote(holder)} ${shellQuote(nonce)} "$(( $(date +%s) + ${ttl} ))" > "$META"
  chmod 600 "$META" 2>/dev/null || true
}
if mkdir "$LOCK" 2>/dev/null; then write; echo ACQUIRED; exit 0; fi
NOW=$(date +%s)
EXP=$(sed -n 's/.*"expiresAt":\\([0-9]*\\).*/\\1/p' "$META" 2>/dev/null); [ -z "$EXP" ] && EXP=0
CUR=$(sed -n 's/.*"holder":"\\([^"]*\\)".*/\\1/p' "$META" 2>/dev/null)
if [ "$NOW" -ge "$EXP" ]; then write; echo TOOKOVER; exit 0; fi
echo "HELD $CUR"; exit 1`;

const verifyScript = (nonce: string, ttl: number): string =>
    `${header("verify", nonce, ttl)}CUR=$(sed -n 's/.*"nonce":"\\([^"]*\\)".*/\\1/p' ${LOCK_DIR}/meta.json 2>/dev/null)
[ "$CUR" = ${shellQuote(nonce)} ] && echo OK || echo "LOST $CUR"`;

const renewScript = (holder: string, nonce: string, ttl: number): string =>
    `${header("renew", nonce, ttl)}LOCK=${LOCK_DIR}
META=$LOCK/meta.json
CUR=$(sed -n 's/.*"nonce":"\\([^"]*\\)".*/\\1/p' "$META" 2>/dev/null)
if [ "$CUR" = ${shellQuote(nonce)} ]; then printf '{"holder":"%s","nonce":"%s","expiresAt":%s}\\n' ${shellQuote(holder)} ${shellQuote(nonce)} "$(( $(date +%s) + ${ttl} ))" > "$META"; echo OK; else echo "LOST $CUR"; fi`;

const releaseScript = (nonce: string, ttl: number): string =>
    `${header("release", nonce, ttl)}LOCK=${LOCK_DIR}
META=$LOCK/meta.json
CUR=$(sed -n 's/.*"nonce":"\\([^"]*\\)".*/\\1/p' "$META" 2>/dev/null)
if [ "$CUR" = ${shellQuote(nonce)} ]; then rm -f "$META"; rmdir "$LOCK" 2>/dev/null; echo RELEASED; else echo "SKIP $CUR"; fi`;

const run = async (executor: SshExecutor, target: SshTarget, command: string): Promise<SshResult> => {
    const session = await executor.connect(target);
    try {
        return await session.exec(command);
    } finally {
        await session.dispose();
    }
};

// Acquires the lock on every host in deterministic order, all-or-abort. An unreachable host is skipped (logged) rather
// than failing the run; a host held by another live run aborts immediately, releasing locks already taken.
export const acquireApplyLock = async (
    executor: SshExecutor,
    targets: readonly SshTarget[],
    options: { readonly ttlSeconds?: number; readonly holder?: string; readonly log?: (message: string) => void } = {},
): Promise<ApplyLock> => {
    const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const holder = options.holder ?? defaultHolder();
    const nonce = randomBytes(16).toString("hex");
    const log = options.log ?? (() => {});
    const held: SshTarget[] = [];

    const releaseAll = async (): Promise<void> => {
        for (const target of held) {
            try {
                await run(executor, target, releaseScript(nonce, ttl));
            } catch (error) {
                log(`apply-lock: failed to release ${lockKey(target)} (it frees after its TTL): ${String(error)}`);
            }
        }
    };

    for (const target of orderedHosts(targets)) {
        let result: SshResult;
        try {
            result = await run(executor, target, acquireScript(holder, nonce, ttl));
        } catch (error) {
            log(`apply-lock: ${lockKey(target)} is not reachable, skipping its lock: ${String(error)}`);
            continue;
        }
        const outcome = result.stdout.trim();
        if (outcome.startsWith("ACQUIRED") || outcome.startsWith("TOOKOVER")) {
            held.push(target);
            continue;
        }
        await releaseAll();
        if (outcome.startsWith("CANNOT_WRITE")) {
            throw new Error(
                `cannot create /opt/intentic on ${lockKey(target)}, the deploy user lacks write permission on it. Re-run this host's connect script (connect.sh for the sandbox's own machine, connect-host.sh for an enrolled host), it provisions /opt/intentic for the service user; or create it as root: mkdir -p /opt/intentic && chown <deploy-user> /opt/intentic`,
            );
        }
        const who = outcome.replace(/^HELD\s*/, "");
        throw new Error(
            `another intentic run holds the apply lock on ${lockKey(target)}${who !== "" ? ` (held by ${who})` : ""}, wait for it to finish, or if it crashed the lock frees after its TTL`,
        );
    }

    return {
        verify: async () => {
            for (const target of held) {
                const result = await run(executor, target, verifyScript(nonce, ttl));
                if (!result.stdout.trim().startsWith("OK")) {
                    throw new Error(
                        `apply lock on ${lockKey(target)} was taken over by another run: aborting before mutating to avoid concurrent writers`,
                    );
                }
            }
        },
        renew: async () => {
            for (const target of held) {
                await run(executor, target, renewScript(holder, nonce, ttl));
            }
        },
        release: releaseAll,
    };
};
