import { type Periodic, startPeriodic } from "@intentic/base/async";
import {
    HOST_NATIVE_ENVIRONMENT,
    type DeviceFacts,
    type HostConnection,
    hostConnectionKey,
    userDistrosOf,
} from "@intentic/sandbox-contract/schemas/hosts";
import type { Services } from "../composition.js";
import { createRepeatGate } from "../logs/repeat-gate.js";
import { opt } from "../opt.js";
import type { PeerState } from "../peers/peer-hub.js";
import { agentInstallLine, codedInstallLine, exitingLine } from "./device-commands.js";
import { callTool } from "./device-reports.js";
import { hostConnectionOf } from "./host-connection.js";
import { errorMessage } from "@intentic/base/errors";

// ONE INSTALL CONNECTS THE WHOLE COMPUTER. The owner connected a PC, not one of its shells, so the moment any
// environment of a machine holds a socket the daemon puts an agent in the rest: from the Windows side into every WSL
// distro it lists, from a distro onto the Windows side. Each lands as a connection of the SAME card
// (`<card>::wsl:<distro>`), so there is nothing else to grant and nothing else to click.
//
// Done from here rather than by the agent: the pairing is a credential only the daemon may mint, and the crossing is
// already a `run_command` argument the machine turns into argv (`wsl.exe --exec sh -lc`). Nothing new is asked of the
// agent beyond the release that took `in`.
//
// AND A WINDOWS SIDE GONE SILENT IS PUT BACK FROM ITS DISTRO (2026-10-15). On 10-13 a desktop-app reinstall ran
// `intentic-machine uninstall` on rog's Windows side while the agent in its WSL distro stayed connected, and for two days
// nothing tried to put it back: the side was ENROLLED, which this file read as "already connected". A distro that answers
// is a PC that is awake, so a Windows side with no socket beside it is an agent that is gone or stuck, not a laptop
// asleep. Past SILENT_BEFORE_REVIVE_MS it is re-linked through the distro with the same install line a never-enrolled
// side gets, when the distro connects and on a clock while it stays connected (the Windows side can drop with the distro
// still up, which no connect says). Only that way round: a distro is never brought back from Windows, since a test distro
// the owner stopped must stay stopped.
//
// What a revive costs on the PC: the install script keeps an installed agent that speaks the `device` route and only
// downloads when there is none (device.ps1's Get-IntenticAgent), then hands over to `device setup`, which self-updates.
// So a side whose agent was uninstalled downloads it again (the case it exists for), and one whose agent is merely stuck
// re-runs setup with a fresh pairing and no download.

// Long enough for a download and a first connect on somebody's laptop, short of the hub's own call ceiling.
const INSTALL_TIMEOUT_MS = 4 * 60_000;
// A machine reconnects whenever it wakes; a failed bootstrap must not be retried on every one of those. Per
// environment, so one distro refusing does not stop the next from being tried. A revive keeps the same clock, so a
// Windows side that cannot be put back is tried twice an hour, not at every sweep.
const RETRY_AFTER_MS = 30 * 60_000;
// How long a Windows side may hold no socket beside a live distro before it is put back: long enough for its own agent to
// redial after this daemon restarts or after an update of its own, short of leaving the owner a morning without a screen.
const SILENT_BEFORE_REVIVE_MS = 10 * 60_000;
// How often the distros holding a socket are looked at for a Windows side gone silent: the hub's own map and one read of
// the enrollments, so it costs nothing on a sandbox with no PC connected.
const REVIVE_SWEEP_MS = 5 * 60_000;
// This daemon's start, which a side that has held no socket since is counted silent from: liveness is in memory, so a
// Windows side that never dialled in after a restart has no last socket to count from.
const BOOTED_AT = Date.now() - Math.round(process.uptime() * 1000);

const attempted = new Map<string, number>();

// A Windows side whose switches refuse commands answers the same refusal at every half-hourly try; said once, then hourly
// with the count, and afresh when the answer changes.
const refusals = createRepeatGate();

// The outcome of an environment that already holds its own enrollment: nothing was run.
const ALREADY_CONNECTED = "already connected";

/** Wipes the cooldown so the next connect tries again: the Connect button on a distro's row, and tests. */
export const forgetBootstrap = (connection?: string): void => void (connection === undefined ? attempted.clear() : attempted.delete(connection));

const isDistro = (environment: string): boolean => environment.startsWith("wsl:");

// Which environments of this machine an agent could be put in from the one that just connected. Read off the
// connected side's own facts: Windows lists its distros, and a distro implies the Windows side it runs on.
export const bootstrapTargets = (environment: string, facts: DeviceFacts): string[] => {
    if (environment === HOST_NATIVE_ENVIRONMENT) {
        return userDistrosOf(facts).map((distro) => `wsl:${distro}`);
    }
    // A distro can only be reached from Windows and can only reach Windows, so its sibling set is that one side.
    return isDistro(environment) ? [HOST_NATIVE_ENVIRONMENT] : [];
};

/** How long a connection has held no socket, from its last one or from this daemon's start; undefined while it holds one. */
export const silenceOf = (state: Pick<PeerState<unknown, unknown>, "online" | "lastSeen">, now: number, bootedAt: number = BOOTED_AT): number | undefined =>
    state.online ? undefined : now - (state.lastSeen ?? bootedAt);

// The one-liner that puts the agent in the target environment, in that environment's own dialect, plus the `in` that
// carries it there: `device/<host>/<code>`, the code standing for a token minted for the connection it enrolls, so a
// redeemed one can only ever become the environment it was meant for. On localhost the token rides as environment.
const installLine = (target: string, url: string, token: string, code: string): { readonly command: string; readonly in: string } => {
    const native = target === HOST_NATIVE_ENVIRONMENT;
    const dialect = native ? "powershell" : "sh";
    return {
        command: exitingLine(
            dialect,
            codedInstallLine(dialect, "device", url, code) ??
                agentInstallLine(dialect, { powershell: "devicePs1", sh: "deviceSh" }, { SANDBOX_URL: `'${url}'`, PAIR_TOKEN: `'${token}'` }),
        ),
        in: native ? "windows" : `wsl:${target.slice("wsl:".length)}`,
    };
};

// Why bootstrapping was asked for: an environment of the machine just said hello, or the clock is looking at the distros
// already connected. The clock only ever revives: an environment that was never enrolled, or whose key the owner revoked,
// is left for the next connect as it always was, so a revoke is never undone behind the owner's back within minutes.
type Occasion = "connect" | "sweep";

// What one environment needs from the side that is up.
type Plan = { readonly kind: "nothing" } | { readonly kind: "install" } | { readonly kind: "revive"; readonly silentMs: number };
const NOTHING: Plan = { kind: "nothing" };

const planFor = async (services: Services, connection: string, target: string, occasion: Occasion, now: number): Promise<Plan> => {
    if (!(await services.hosts.enrolled(connection))) {
        return occasion === "connect" ? { kind: "install" } : NOTHING;
    }
    // Only a Windows side, which only a distro names as its target: Windows never revives a distro.
    if (target !== HOST_NATIVE_ENVIRONMENT) {
        return NOTHING;
    }
    const silent = silenceOf(services.hostHub.state(connection), now);
    return silent !== undefined && silent >= SILENT_BEFORE_REVIVE_MS ? { kind: "revive", silentMs: silent } : NOTHING;
};

// Puts an agent in one environment through the connection we already have. Returns what happened for the log, never
// throws: a machine whose owner switched commands off, or a distro that has no curl, is a fact about that machine and
// not a failure of the connection that triggered this.
const linkThrough = async (services: Services, from: string, connection: string, target: string): Promise<{ readonly outcome: string; readonly refused: boolean }> => {
    const url = services.config.sandbox.publicUrl;
    if (url === "") {
        return { outcome: "this sandbox has no public address for a device to dial yet", refused: false };
    }
    // A side that is already enrolled is minted a pairing like a new one, and redeeming it replaces that side's record
    // and its key in one write (Enrollments.issue rotates: the old digest stops verifying as the new one lands), so a
    // revive never leaves two keys valid for one side. The old key is deliberately NOT revoked first: a revive that fails
    // part way (no download, a refused switch, a laptop shut mid-install) then leaves the side exactly as it was, and an
    // agent that was only stuck still gets back in with the key it holds.
    const { token, expiresIn } = services.hosts.mintPairing(connection);
    const code = services.redeemCodes.mint({ kind: "device", pairToken: token }, expiresIn);
    const line = installLine(target, url, token, code);
    const answer = await callTool(
        services,
        from,
        "run_command",
        { command: line.command, in: line.in, timeoutMs: INSTALL_TIMEOUT_MS },
        AbortSignal.timeout(INSTALL_TIMEOUT_MS + 5_000),
    ).catch((error: unknown) => ({ text: errorMessage(error), refused: false }));
    return answer.refused
        ? { outcome: `refused by that device: ${answer.text.trim()}`, refused: true }
        : { outcome: answer.text.trim().split("\n")[0] ?? "ran", refused: false };
};

// One environment of the machine, from the side that is up.
interface Step {
    readonly from: string;
    readonly card: string;
    readonly environment: string;
    readonly target: string;
    readonly connection: string;
    readonly occasion: Occasion;
}

// The revive's line: what was tried, through which distro, after how long, and what came of it.
const noteRevival = (services: Services, step: Step, silentMs: number, result: { readonly outcome: string; readonly refused: boolean }): void => {
    const distro = step.environment.slice("wsl:".length);
    const minutes = Math.round(silentMs / 60_000);
    const verdict = result.refused ? refusals.check(step.connection, result.outcome) : { log: true, repeated: 0 };
    if (!result.refused) {
        refusals.clear(step.connection);
    }
    services.logger[verdict.log ? "info" : "debug"](
        {
            card: step.card,
            environment: step.target,
            through: step.from,
            silentMs,
            outcome: result.outcome,
            ...opt("repeated", verdict.repeated > 0 ? verdict.repeated : undefined),
        },
        `hosts: reconnecting the Windows side of ${step.card} through ${distro} (silent ${minutes} min): ${result.outcome}`,
    );
};

const bootstrapOne = async (services: Services, step: Step, now: number): Promise<void> => {
    const plan = await planFor(services, step.connection, step.target, step.occasion, now);
    if (plan.kind === "nothing") {
        // Nothing was run, so nothing holds the next look back: a Windows side not yet silent long enough is looked at
        // again by the next sweep, not half an hour later.
        if (attempted.get(step.connection) === now) {
            attempted.delete(step.connection);
        }
        // Every reconnect of a machine re-checks its environments, and nearly every check finds them already connected:
        // nothing happened, so it is a trace, not news. The clock's own looks are not even that.
        if (step.occasion === "connect") {
            services.logger.debug({ card: step.card, environment: step.target, outcome: ALREADY_CONNECTED }, "hosts: connecting the rest of this computer");
        }
        return;
    }
    const result = await linkThrough(services, step.from, step.connection, step.target);
    if (plan.kind === "revive") {
        noteRevival(services, step, plan.silentMs, result);
        return;
    }
    services.logger.info({ card: step.card, environment: step.target, outcome: result.outcome }, "hosts: connecting the rest of this computer");
};

// Called when an environment of a machine comes up and says what it is. Fire-and-forget by design: a connect must not
// wait on a download, and the agent it installs arrives as its own connection when it is ready. Which card and
// environment the connection is comes off its enrollment's record.
export const bootstrapEnvironments = (services: Services, from: string, facts: DeviceFacts): void => {
    void hostConnectionOf(services, from)
        .then((connection) => bootstrapFrom(services, from, connection, facts, "connect"))
        .catch((error: Error) => services.logger.warn({ err: error, connection: from }, "hosts: could not read which computer connected"));
};

const bootstrapFrom = (services: Services, from: string, { card, environment }: HostConnection, facts: DeviceFacts, occasion: Occasion): void => {
    const now = Date.now();
    for (const target of bootstrapTargets(environment, facts)) {
        const connection = hostConnectionKey(card, target);
        const last = attempted.get(connection);
        if (last !== undefined && now - last < RETRY_AFTER_MS) {
            continue;
        }
        // Held from here, while it is decided and run, so a second hello meanwhile never starts the same install twice.
        attempted.set(connection, now);
        void bootstrapOne(services, { from, card, environment, target, connection, occasion }, now).catch((error: unknown) => {
            services.logger.warn({ err: error, card, environment: target }, "hosts: could not connect that environment");
        });
    }
};

/** One look at every distro holding a socket, for a Windows side beside it gone silent. Exported for its test. */
export const reviveSilentWindows = async (services: Services): Promise<void> => {
    const connected = new Set(services.hostHub.connected());
    if (connected.size === 0) {
        return;
    }
    for (const record of await services.hosts.list()) {
        const facts = services.hostHub.state(record.id).facts;
        // A distro that has not described itself yet is seconds from having said hello, which looks at it anyway.
        if (isDistro(record.environment) && connected.has(record.id) && facts !== undefined) {
            bootstrapFrom(services, record.id, record, facts, "sweep");
        }
    }
};

/** The clock behind reviveSilentWindows, disposed with the daemon. */
export const startWindowsRevival = (services: Services): Periodic =>
    startPeriodic({
        everyMs: REVIVE_SWEEP_MS,
        run: () => reviveSilentWindows(services),
        onError: (error) => services.logger.warn({ err: error }, "hosts: could not look for a Windows side gone silent beside its distro"),
    });
