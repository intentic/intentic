import { errorMessage } from "@intentic/base/errors";
import type { CiFleetPass, CiRunner } from "@intentic/sandbox-contract/schemas/ci-fleet";
import type { Rounds } from "../../device/sandbox-rounds/ic-rounds.js";
import { startRounds } from "../../device/sandbox-rounds/ic-rounds.js";
import { runnerRetryMs } from "../../device/sandbox-rounds/runner-keeper.js";
import { type FleetContext, keptPass } from "../context.js";
import { systemctl } from "../units.js";

/* THE KEEPER: every minute, a runner unit that is down (`inactive` or `failed`) and that nobody holds down is started.
   The runner units carry no Restart=, so a listener that exited (a crash, a network drop it gave up on, a self-update
   that failed halfway) stayed down until somebody noticed; setup-wsl-fleet.ps1's reconciler closed that gap on omen
   every three minutes from Windows, and a native Linux host had nothing. Left alone:
   - a runner held down on purpose: stopped from the board, drained, or paused by wsl-workers.sh for a Windows smoke job;
   - one draining, whose stop is the drain's to make, and one busy, which is up whatever its unit says;
   - one whose unit is gone from systemd (`not-installed`): only re-registering, or its own `svc.sh install`, brings it
     back, so it is said once a stretch, never retried.
   A start that does not bring the runner back makes the next wait longer, ten minutes doubling to four hours as the
   sandbox runners' keeper waits (runner-keeper.ts), so a runner broken for good costs a start every few hours, not a
   storm. Each standing verdict is said to the log once, when it changes; the status keeps every runner's current one. */

const KEEPER_EVERY_MS = 60_000;
// The first round after the service starts: past the runners' own start at boot.
const KEEPER_FIRST_MS = 30_000;

// What the keeper remembers of one runner between rounds: starts that did not bring it back, and when the next may be.
export interface KeeperWatch {
    tries: number;
    retryAt: number;
}

export interface KeeperState {
    readonly watches: Map<string, KeeperWatch>;
    // The verdict last said per runner, so a standing one is said once.
    readonly said: Map<string, string>;
}

export const newKeeperState = (): KeeperState => ({ watches: new Map(), said: new Map() });

// What one round decides for one runner.
export type KeeperVerdict = { readonly kind: "up" } | { readonly kind: "leave"; readonly why: string } | { readonly kind: "start" } | { readonly kind: "wait"; readonly until: number };

const DOWN = new Set(["inactive", "failed"]);

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

// Why a runner the keeper will not start is down, or undefined for one it may start (or that is up).
const leftAlone = (runner: CiRunner): string | undefined => {
    if (runner.held !== undefined) {
        return `${runner.name} is held down (${runner.held}); left stopped`;
    }
    if (runner.draining) {
        return `${runner.name} is draining; its stop is the drain's`;
    }
    if (runner.state === "not-installed") {
        return `${runner.name}'s unit (${runner.unit}) is gone from systemd, which the keeper cannot fix: register it again, or run its own \`sudo ./svc.sh install\` in ${runner.dir}`;
    }
    if (runner.state === "unknown") {
        return `${runner.name}'s unit is in a state this keeper does not know; left as it is`;
    }
    return undefined;
};

/** One runner's verdict, pure over what discovery read and what the keeper remembers. */
export const keeperVerdict = (runner: CiRunner, watch: KeeperWatch | undefined, now: number): KeeperVerdict => {
    const why = leftAlone(runner);
    if (why !== undefined) {
        return { kind: "leave", why };
    }
    if (runner.busy || !DOWN.has(runner.state)) {
        return { kind: "up" };
    }
    if (watch !== undefined && now < watch.retryAt) {
        return { kind: "wait", until: watch.retryAt };
    }
    return { kind: "start" };
};

// Says a standing line to the log only when it differs from the last said for that runner.
const sayOnce = (context: FleetContext, state: KeeperState, name: string, line: string): void => {
    if (state.said.get(name) !== line) {
        state.said.set(name, line);
        context.log(`keeper: ${line}`);
    }
};

const startOne = async (context: FleetContext, state: KeeperState, runner: CiRunner, now: number): Promise<string> => {
    const tries = (state.watches.get(runner.name)?.tries ?? 0) + 1;
    state.watches.set(runner.name, { tries, retryAt: now + runnerRetryMs(tries) });
    const release = context.busy.hold();
    try {
        await systemctl(context, "start", runner.unit);
        return `started ${runner.name} (its unit was ${runner.state}; start ${tries}, the next no sooner than ${minutes(runnerRetryMs(tries))} if it does not stay up)`;
    } catch (error) {
        return `could not start ${runner.name} (start ${tries}, again in ${minutes(runnerRetryMs(tries))}): ${errorMessage(error)}`;
    } finally {
        release();
    }
};

// One runner: its line for the pass, or undefined for one that is up and has nothing to say.
const keepOne = async (context: FleetContext, state: KeeperState, runner: CiRunner, now: number): Promise<string | undefined> => {
    const verdict = keeperVerdict(runner, state.watches.get(runner.name), now);
    switch (verdict.kind) {
        case "up": {
            const watched = state.watches.delete(runner.name);
            state.said.delete(runner.name);
            if (watched) {
                context.log(`keeper: ${runner.name} is back up`);
            }
            return undefined;
        }
        case "leave":
            sayOnce(context, state, runner.name, verdict.why);
            return verdict.why;
        case "wait": {
            const line = `${runner.name} is still ${runner.state} after a start; the next start waits until ${new Date(verdict.until).toISOString()}`;
            sayOnce(context, state, runner.name, line);
            return line;
        }
        case "start": {
            const line = await startOne(context, state, runner, now);
            state.said.set(runner.name, line);
            context.log(`keeper: ${line}`);
            return line;
        }
    }
};

/** One round over every runner; the pass it makes goes to the status as `keeper`. */
export const keeperRound = async (context: FleetContext, state: KeeperState): Promise<CiFleetPass> => {
    const { runners } = await context.discover();
    const now = context.sys.now();
    const names = new Set(runners.map((runner) => runner.name));
    // A runner gone from the computer takes what was remembered of it, so a reused name starts fresh.
    for (const name of [...state.watches.keys(), ...state.said.keys()]) {
        if (!names.has(name)) {
            state.watches.delete(name);
            state.said.delete(name);
        }
    }
    const lines: string[] = [];
    for (const runner of runners) {
        // one systemctl at a time: each start is systemd's own, and a round is a handful of runners
        const line = await keepOne(context, state, runner, now);
        if (line !== undefined) {
            lines.push(line);
        }
    }
    const pass: CiFleetPass = { at: new Date(now).toISOString(), dryRun: false, freedBytes: 0, lines };
    await context.status.update({ keeper: keptPass(pass) });
    return pass;
};

export const startKeeper = (context: FleetContext): Rounds => {
    if (!context.config.keeper.enabled) {
        return { stop: () => undefined, running: () => false };
    }
    const state = newKeeperState();
    return startRounds("keeper", context.log, KEEPER_FIRST_MS, () => KEEPER_EVERY_MS, async () => {
        await keeperRound(context, state);
    });
};
