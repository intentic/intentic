// THE CI HOST'S TEST MEMORY, AS ONE POOL EVERY JOB ON IT DRAWS FROM. Six runner processes share one machine
// (docs/ops/ci-runner.md) and no container can see the others, so every fan-out used to be sized as if all six were
// running the heaviest suite at once: test-workers.mjs divided the free memory by CI_HOST_JOBS and then by turbo's four
// tasks, which on the 26 GB fleet comes to one bun worker per package, always. The web suite (875 files) ran on that one
// worker for 19 to 25 minutes while most of the machine's cores sat idle (measured 2026-10-07).
//
// A pool says what a division can only guess: what the other jobs hold RIGHT NOW. The host's test budget is TEST_SLOTS
// files of one GiB each in TEST_SLOTS_DIR (a directory every job mounts, /ci-cache/test-slots on the fleet), and a run
// holds a slot by holding an flock on its file. A run takes what it wants of what is free, at most SHARE_PERCENT of it so
// the job that starts a second later is not left with nothing, and the kernel gives the slots back when the holder exits,
// however it exits: a killed job cannot leak one.
//
// FIRST COME WAS NOT ENOUGH. On the second pipeline after the pool landed (run 37694899281, 2026-10-07) the web suite,
// the one the platform gate waits on, found 2 slots free and ran its 877 files on ONE worker for 14.6 minutes, while
// verify-clocks (which gates nothing) and a superseded push's jobs held the rest; on the run before, with the pool to
// itself, the same suite took 4.3 minutes on four. So the pool has three more knobs, all off unless a job sets them:
//   TEST_SLOTS_RESERVED  the first N slots only a gate run may take (TEST_SLOTS_PRIORITY=gate: verify.yml's groups,
//                        whose suites production and the release wait on); every other run draws from the rest.
//   TEST_SLOTS_CAP       the most slots one run of this job may hold (verify-clocks: its two zones are worth a few
//                        workers, not the box).
//   TEST_SLOTS_WAIT      seconds a run that got less than it needs may keep polling for more (acquireAtLeast). A big
//                        suite that starts short-handed stays short-handed, since bun's worker count is fixed at start,
//                        so a bounded wait for room is worth minutes; a small suite never waits.
import { spawn } from "node:child_process";

export const SLOT_BYTES = 1024 ** 3;
// The most of what is free one run may take, in percent.
export const SHARE_PERCENT = 75;
// How often a waiting run asks the pool again.
export const POLL_MS = 5_000;

const wholeNumber = (raw) => {
    const value = Number(raw);
    return raw !== undefined && raw !== "" && Number.isInteger(value) && value >= 0 ? value : undefined;
};

// The pool this process may draw from, or undefined where none is configured (a laptop, a sandbox: those size from their
// own free memory, test-workers.mjs). `reserved` is clamped below the total, so an open run always has a slot to try.
export const poolOf = (env = process.env) => {
    const dir = env.TEST_SLOTS_DIR;
    const total = Number(env.TEST_SLOTS);
    if (dir === undefined || dir === "" || !Number.isInteger(total) || total < 1) {
        return undefined;
    }
    const cap = wholeNumber(env.TEST_SLOTS_CAP);
    return {
        dir,
        total,
        reserved: Math.min(total - 1, wholeNumber(env.TEST_SLOTS_RESERVED) ?? 0),
        gate: env.TEST_SLOTS_PRIORITY === "gate",
        cap: cap === undefined || cap < 1 ? undefined : cap,
        waitMs: (wholeNumber(env.TEST_SLOTS_WAIT) ?? 0) * 1000,
    };
};

// The slot numbers a run of `pool` may try, first to last: a gate run every slot, the reserved band first; any other
// run only the slots above it.
export const slotRange = (pool) => ({ first: pool.gate ? 1 : (pool.reserved ?? 0) + 1, last: pool.total });

// What one run may hold of `want`: no more than the job's cap.
const capped = (pool, want) => Math.min(want, pool?.cap ?? want);

// Bash holds the locks, since node has no flock: it tries every slot in its range without waiting, keeps the share it
// may, prints how many it kept, then waits on stdin. Closing stdin (release, or this process dying) ends it, and its locks
// with it.
const HOLDER = `
dir=$1 first=$2 last=$3 want=$4 share=$5
mkdir -p "$dir" 2>/dev/null || { echo 0; exit 0; }
held=()
for i in $(seq "$first" "$last"); do
  exec {fd}>>"$dir/slot-$i" 2>/dev/null || continue
  if flock -n "$fd"; then held+=("$fd"); else exec {fd}>&-; fi
done
got=\${#held[@]}
keep=$(( (got * share + 99) / 100 ))
[ "$keep" -gt "$want" ] && keep=$want
for ((k = keep; k < got; k++)); do eval "exec \${held[$k]}>&-"; done
echo "$keep"
read -r _ || true
`;

const NOTHING = Object.freeze({ slots: 0, release: () => {} });

// Up to `want` slots of `pool`, held until `release()` is called or this process exits. Anything that goes wrong (no
// bash, no flock, an unwritable directory) holds nothing, and the caller runs as it would have without a pool.
export const acquireSlots = (pool, want) =>
    new Promise((resolve) => {
        const asked = capped(pool, want);
        if (pool === undefined || asked < 1) {
            resolve(NOTHING);
            return;
        }
        const { first, last } = slotRange(pool);
        let child;
        try {
            child = spawn("bash", ["-c", HOLDER, "test-memory-pool", pool.dir, String(first), String(last), String(asked), String(SHARE_PERCENT)], {
                stdio: ["pipe", "pipe", "ignore"],
            });
        } catch {
            // allow(silent-catch): no bash to hold the locks is no pool, which is one worker
            resolve(NOTHING);
            return;
        }
        let out = "";
        let settled = false;
        const settle = (value) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };
        child.on("error", () => settle(NOTHING));
        child.on("exit", () => settle(NOTHING));
        // A holder whose parent stops reading must not keep this process alive past its own work.
        child.stdin.on("error", () => {});
        child.stdout.on("data", (chunk) => {
            out += chunk;
            const end = out.indexOf("\n");
            if (end === -1) {
                return;
            }
            const slots = Number.parseInt(out.slice(0, end), 10);
            if (!Number.isInteger(slots) || slots < 1) {
                child.stdin.end();
                settle(NOTHING);
                return;
            }
            settle({ slots, release: () => child.stdin.end() });
        });
    });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Up to `want` slots, and if the first answer holds fewer than `least`, more asked for every `pollMs` until it does or
// the pool's TEST_SLOTS_WAIT runs out. What each ask got is kept, so a run that waits never ends with less than it had.
// `least` past what the job may hold (its cap) is lowered to the cap: a wait for slots the cap forbids would always time
// out. `waitedMs` is how long it actually waited, for the run's own log line.
export const acquireAtLeast = async (pool, want, least, { pollMs = POLL_MS } = {}) => {
    const limit = capped(pool, want);
    const goal = Math.min(least, limit);
    const holders = [await acquireSlots(pool, limit)];
    const held = () => holders.reduce((sum, holder) => sum + holder.slots, 0);
    const started = Date.now();
    const deadline = started + (pool?.waitMs ?? 0);
    while (held() < goal && Date.now() < deadline) {
        await pause(Math.min(pollMs, deadline - Date.now()));
        const more = await acquireSlots(pool, limit - held());
        if (more.slots > 0) {
            holders.push(more);
        }
    }
    return {
        slots: held(),
        waitedMs: held() < goal || holders.length > 1 ? Date.now() - started : 0,
        release: () => {
            for (const holder of holders) {
                holder.release();
            }
        },
    };
};
