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
// NEVER A WAIT. A run that finds the pool empty gets nothing and runs one worker, which is what every run got before the
// pool existed; so the pool can only ever add workers, never stall a job behind another.
import { spawn } from "node:child_process";

export const SLOT_BYTES = 1024 ** 3;
// The most of what is free one run may take, in percent.
export const SHARE_PERCENT = 75;

// The pool this process may draw from, or undefined where none is configured (a laptop, a sandbox: those size from their
// own free memory, test-workers.mjs).
export const poolOf = (env = process.env) => {
    const dir = env.TEST_SLOTS_DIR;
    const total = Number(env.TEST_SLOTS);
    return dir === undefined || dir === "" || !Number.isInteger(total) || total < 1 ? undefined : { dir, total };
};

// Bash holds the locks, since node has no flock: it tries every slot without waiting, keeps the share it may, prints how
// many it kept, then waits on stdin. Closing stdin (release, or this process dying) ends it, and its locks with it.
const HOLDER = `
dir=$1 total=$2 want=$3 share=$4
mkdir -p "$dir" 2>/dev/null || { echo 0; exit 0; }
held=()
for i in $(seq 1 "$total"); do
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
        if (pool === undefined || want < 1) {
            resolve(NOTHING);
            return;
        }
        let child;
        try {
            child = spawn("bash", ["-c", HOLDER, "test-memory-pool", pool.dir, String(pool.total), String(want), String(SHARE_PERCENT)], {
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
