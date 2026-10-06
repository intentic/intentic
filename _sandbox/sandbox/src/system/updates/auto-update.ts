import { serialLock } from "@intentic/base/async";
import type { AutoUpdate, AutoUpdateHold, AutoUpdateInput, DeviceFlowLine, DeviceSandboxFlow, StagedUpdate } from "@intentic/sandbox-contract";
import { isNewer } from "@intentic/sandbox-contract";
import type { RestartResume } from "../restart-resume.js";
import { askedRestart } from "../restart-resume.js";
import { opt } from "../../opt.js";
import type { UpdatePolicyFile } from "./update-policy.js";

// TAKING AN UPDATE BY ITSELF, AT A MOMENT NOBODY FEELS. Everything an update costs nobody already happens unasked: the
// machine that runs this sandbox downloads and builds the next release in the background (`ic sandbox prepare --auto`,
// the machine agent's round) and pre-flights its state conversions against this sandbox's files. What is left is a
// restart of about half a minute, and this decides its moment, because only this daemon can see who it would interrupt:
// agents mid-turn, people at the editor, a terminal still printing, an automation about to fire.
//
// - Only a STAGED update is taken. One that still has to download is minutes of downtime, which stays a person's call.
// - It waits until nothing it can see is going on, then counts down: long enough to be seen by anyone still connected,
//   who can stop it, and long enough that the turn queued behind the one that just ended has started and holds it again.
// - It hands the machine exactly what the Update button sends, asking the next boot to pick up any turn the restart cuts
//   (restart-resume.ts), and writes down that it did, so the version that comes up can say it happened by itself.
// - A release that changes what developers build on (breaking notes) is never taken unasked. Neither is a version the
//   owner skipped, one whose pre-flight refused this sandbox's files, nor one a newer release overtook (the swap would
//   pull the moved tag and download after all).
// - The wait is kept in memory; a restart for any other reason starts it over, which is what the restart was anyway.

// How often the moment is looked for while an update waits. Turns end at their own pace; a few seconds more cost nothing.
const POLL_MS = 15_000;
// The countdown once nothing holds it: seen by a person still connected (an editor left open), and a settle for the
// sandbox nobody is connected to, so a turn queued behind the one that just ended starts and holds the update again.
const COUNTDOWN_SEEN_MS = 90_000;
const COUNTDOWN_UNSEEN_MS = 60_000;
// A terminal that printed within this window is somebody's work still going (a build, a test run, a person typing).
export const TERMINAL_QUIET_MS = 10 * 60_000;
// ...until the update has waited this long: a dev server that logs every few minutes must not hold a release forever.
// Agents and people never stop holding it, since cutting either is exactly what this exists not to do.
export const TERMINAL_PATIENCE_MS = 24 * 60 * 60_000;
// An automation or a scheduled message due this soon would land in the restart; it goes first.
export const SCHEDULE_LEAD_MS = 10 * 60_000;
// How long this process may outlive a machine stream that stopped without a word before that stop was not the cutover.
const CUTOVER_GRACE_MS = 3 * 60_000;
// A try that did not take is tried again later, each time later still: a machine refusing for a reason (low disk, a swap
// of its own under way) is not helped by being asked every minute.
const RETRY_MS = [60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000, 24 * 60 * 60_000] as const;
// How often an unknown machine is asked after rather than read from what is held: a laptop asleep costs a round trip.
const MACHINE_LOOK_MS = 5 * 60_000;
// How early a countdown's own timer may fire and still be its moment.
const TIMER_SLACK_MS = 1_000;

const LOST = "Lost contact with the machine before this sandbox restarted. It may still have updated; if not, it is tried again later.";
const UNSAID = "The machine finished without restarting this sandbox.";

// A version as release versions are compared (version-check.ts): without the tag's `v`.
const bare = (version: string): string => version.replace(/^v/, "");

// What there is to take, as the daemon reads it: the host's staged marker and download, and the releases it knows.
export interface AutoUpdateOffer {
    // This build's version; undefined on a build that does not know it, which takes nothing.
    readonly running: string | undefined;
    readonly staged: StagedUpdate | undefined;
    // A download running on the machine right now: it is restaging, so what is staged may be about to be replaced.
    readonly preparing: boolean;
    readonly latest: string | undefined;
    readonly skipped: string | undefined;
    // Whether any release in the gap takes something away from developers (release-notes.ts breakingNotes).
    readonly breaking: boolean;
}

/** The version a staged update would move this sandbox onto, when it is one to take by itself; undefined otherwise. */
export const takeableVersion = (offer: AutoUpdateOffer): string | undefined => {
    const { running, staged, latest } = offer;
    if (running === undefined || staged === undefined || offer.preparing || staged.plan?.ok === false) {
        return undefined;
    }
    // A staged build that did not say what it is is the release on offer, as the update card reads it.
    const named = staged.version ?? latest;
    if (named === undefined) {
        return undefined;
    }
    const version = bare(named);
    if (!isNewer(version, bare(running)) || version === offer.skipped) {
        return undefined;
    }
    // Overtaken by a newer release: the swap would pull the moved tag and download it, minutes instead of seconds.
    return latest !== undefined && isNewer(bare(latest), version) ? undefined : version;
};

// What is going on in this sandbox right now, as the moment is judged.
export interface AutoUpdateActivity {
    // Agents mid-turn or landing, subagents and workflows running, by name.
    readonly working: readonly string[];
    // People with the editor on screen and in use, by name.
    readonly people: readonly string[];
    // Editor connections of any kind, on screen or not: whether a countdown has anyone to be seen by.
    readonly connected: number;
    // The latest terminal output, in ms; 0 for none.
    readonly terminalAt: number;
    // The soonest scheduled moment (an automation's run, a scheduled message), in ms; 0 for none.
    readonly dueAt: number;
}

export interface HoldFacts {
    readonly activity: AutoUpdateActivity;
    readonly breaking: boolean;
    readonly pausedUntil: number | undefined;
    readonly host: string | undefined;
    readonly retryAt: number | undefined;
    // When this update started waiting, which decides how long a busy terminal may still hold it.
    readonly waitingSince: number;
    readonly now: number;
}

/** Everything keeping a staged update waiting, the one most likely to last first; empty means now is the moment. */
export const holdsOf = ({ activity, breaking, pausedUntil, host, retryAt, waitingSince, now }: HoldFacts): AutoUpdateHold[] => {
    const holds: AutoUpdateHold[] = [];
    if (breaking) {
        holds.push({ kind: "consent" });
    }
    if (pausedUntil !== undefined && pausedUntil > now) {
        holds.push({ kind: "paused", until: pausedUntil });
    }
    if (host === undefined) {
        holds.push({ kind: "machine" });
    }
    if (retryAt !== undefined && retryAt > now) {
        holds.push({ kind: "retry", until: retryAt });
    }
    if (activity.working.length > 0) {
        holds.push({ kind: "agents", names: [...activity.working] });
    }
    if (activity.people.length > 0) {
        holds.push({ kind: "people", names: [...activity.people] });
    }
    if (activity.dueAt > 0 && activity.dueAt - now <= SCHEDULE_LEAD_MS) {
        holds.push({ kind: "schedule", until: activity.dueAt });
    }
    const terminalBusy = activity.terminalAt > 0 && now - activity.terminalAt < TERMINAL_QUIET_MS;
    if (terminalBusy && now - waitingSince < TERMINAL_PATIENCE_MS) {
        holds.push({ kind: "terminal", until: activity.terminalAt + TERMINAL_QUIET_MS });
    }
    return holds;
};

export interface AutoUpdateDeps {
    readonly offer: () => Promise<AutoUpdateOffer>;
    readonly activity: () => Promise<AutoUpdateActivity>;
    readonly policy: UpdatePolicyFile;
    // The connected machine running this sandbox: `fresh` asks the machines rather than reading what is held.
    readonly host: (fresh: boolean) => Promise<string | undefined>;
    // The swap relayed to the machine, as the Update button relays it (device-reports.ts manageDeviceSandbox).
    readonly relay: (host: string, flow: DeviceSandboxFlow) => AsyncIterable<DeviceFlowLine>;
    readonly restartResume: RestartResume;
    // This sandbox's name on its machine.
    readonly slug: string;
    // The state moved: every page is told (the `update` runtime domain), wherever its reader is.
    readonly changed: () => void;
    readonly logger: { readonly info: (fields: object, message: string) => void; readonly warn: (fields: object, message: string) => void };
    readonly now?: () => number;
    readonly pollMs?: number;
    readonly countdownMs?: { readonly seen: number; readonly unseen: number };
    readonly cutoverGraceMs?: number;
}

export interface AutoUpdater {
    // Where it stands, as /info carries it.
    readonly state: () => Promise<AutoUpdate>;
    // The owner's say; answers with where it stands afterwards. Throws a sentence for an applyNow that cannot be.
    readonly configure: (input: AutoUpdateInput) => Promise<AutoUpdate>;
    // Something it judges by moved (presence): look now rather than at the next poll.
    readonly poke: () => void;
    readonly stop: () => void;
}

type Phase = "idle" | "waiting" | "countdown" | "updating";

export const createAutoUpdater = (deps: AutoUpdateDeps): AutoUpdater => {
    const now = deps.now ?? Date.now;
    const countdown = deps.countdownMs ?? { seen: COUNTDOWN_SEEN_MS, unseen: COUNTDOWN_UNSEEN_MS };
    let phase: Phase = "idle";
    let enabled = true;
    let version: string | undefined;
    let waitingSince = 0;
    let holds: AutoUpdateHold[] = [];
    let startsAt: number | undefined;
    // How early the countdown's own timer may fire and still be its moment: a sliver of the countdown, never more.
    let slack = 0;
    let pausedUntil: number | undefined;
    let lastApplied: AutoUpdate["lastApplied"];
    // The last try that did not take: its words, when it is tried again, and how many in a row for this version.
    let failure: { readonly message: string; readonly retryAt: number; readonly count: number } | undefined;
    let hostLookedAt = 0;
    let said = "";
    let stopped = false;
    let looked = false;

    const snapshot = (): AutoUpdate => ({
        enabled,
        phase,
        ...opt("version", version),
        holds,
        ...opt("startsAt", startsAt),
        ...opt("pausedUntil", pausedUntil),
        ...opt("failure", failure?.message),
        ...opt("lastApplied", lastApplied),
    });
    const publish = (): void => {
        const next = JSON.stringify(snapshot());
        if (next !== said) {
            said = next;
            deps.changed();
        }
    };

    // One look at a time, and an owner's press queued behind the look in flight rather than racing it. The swap itself
    // runs beside the chain, never in it: it lasts until this process is stopped, and nothing may queue behind that.
    const serialize = serialLock();
    const lookSoon = (): void => {
        void serialize(look).catch((error: unknown) => deps.logger.warn({ err: error }, "auto-update look failed"));
    };

    let countdownTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const clearCountdown = (): void => {
        clearTimeout(countdownTimer);
        countdownTimer = undefined;
        startsAt = undefined;
    };

    // The machine running this sandbox, from what is held; asked after now and then while unknown, never every look.
    const hostNow = async (): Promise<string | undefined> => {
        const held = await deps.host(false);
        if (held !== undefined || now() - hostLookedAt < MACHINE_LOOK_MS) {
            return held;
        }
        hostLookedAt = now();
        return await deps.host(true);
    };

    const fail = async (message: string): Promise<void> => {
        const count = (failure?.count ?? 0) + 1;
        const retryAt = now() + RETRY_MS[Math.min(count, RETRY_MS.length) - 1]!;
        failure = { message, retryAt, count };
        deps.logger.warn({ version, failure: message, retryAt }, "auto-update: the machine did not update this sandbox, trying again later");
        await deps.policy.applied(undefined);
        phase = "waiting";
        publish();
    };

    // Hands the machine the update, as the Update button would. A stream that just stops is the cutover: this process is
    // about to be stopped, and the next boot resumes what the restart cut. One that answers in words did not restart.
    const apply = async (target: string | undefined, host: string): Promise<void> => {
        clearCountdown();
        phase = "updating";
        holds = [];
        publish();
        const at = now();
        await deps.policy.applied({ at, ...opt("to", target) });
        deps.logger.info({ host, version: target }, "auto-update: nothing here would feel the restart, the machine updates this sandbox now");
        let answered = false;
        let words: string | undefined;
        try {
            for await (const line of askedRestart(deps.restartResume, at, deps.relay(host, { op: "update", slug: deps.slug }))) {
                if (line.kind !== "line") {
                    answered = true;
                    words = line.message;
                }
            }
        } catch (error) {
            answered = true;
            words = error instanceof Error ? error.message : String(error);
        }
        if (answered) {
            await fail(words ?? UNSAID);
            return;
        }
        graceTimer = setTimeout(() => void serialize(() => (phase === "updating" ? fail(LOST) : Promise.resolve())), deps.cutoverGraceMs ?? CUTOVER_GRACE_MS);
        graceTimer.unref?.();
    };

    // One look: what there is to take, what holds it, and whether the countdown has run out.
    async function look(): Promise<void> {
        if (stopped || phase === "updating") {
            return;
        }
        const [policy, offer] = await Promise.all([deps.policy.read(), deps.offer()]);
        looked = true;
        enabled = policy.auto !== false;
        pausedUntil = policy.pausedUntil !== undefined && policy.pausedUntil > now() ? policy.pausedUntil : undefined;
        // Read back only once it is the version that runs: an update that never came up says so through the host's own
        // outcome, and must not read as one taken by itself.
        lastApplied =
            policy.applied !== undefined && offer.running !== undefined && (policy.applied.to === undefined || bare(policy.applied.to) === bare(offer.running))
                ? policy.applied
                : undefined;
        const target = enabled ? takeableVersion(offer) : undefined;
        if (target === undefined) {
            clearCountdown();
            phase = "idle";
            version = undefined;
            holds = [];
            publish();
            return;
        }
        // A new release is a fresh start: its own wait, and none of the last one's failures.
        if (target !== version) {
            version = target;
            waitingSince = now();
            failure = undefined;
        }
        const [activity, host] = await Promise.all([deps.activity(), hostNow()]);
        holds = holdsOf({ activity, breaking: offer.breaking, pausedUntil, host, retryAt: failure?.retryAt, waitingSince, now: now() });
        if (holds.length > 0 || host === undefined) {
            clearCountdown();
            phase = "waiting";
            publish();
            return;
        }
        if (phase !== "countdown" || startsAt === undefined) {
            phase = "countdown";
            const wait = activity.connected > 0 ? countdown.seen : countdown.unseen;
            startsAt = now() + wait;
            slack = Math.min(TIMER_SLACK_MS, wait / 20);
            countdownTimer = setTimeout(lookSoon, wait);
            countdownTimer.unref?.();
            publish();
            return;
        }
        // A timer may fire a hair early; the moment is the moment.
        if (now() >= startsAt - slack) {
            void apply(version, host).catch((error: unknown) => deps.logger.warn({ err: error }, "auto-update: handing the update to the machine failed"));
            return;
        }
        publish();
    }

    const poller = setInterval(lookSoon, deps.pollMs ?? POLL_MS);
    poller.unref?.();
    lookSoon();

    let pokeTimer: ReturnType<typeof setTimeout> | undefined;

    return {
        // Never waits on a look, which may be asking a machine on the other side of the world: before the first one
        // lands, the owner's own switch and pause are read straight from the file, so the card never draws the wrong one.
        state: async () => {
            if (!looked) {
                const policy = await deps.policy.read();
                enabled = policy.auto !== false;
                pausedUntil = policy.pausedUntil !== undefined && policy.pausedUntil > now() ? policy.pausedUntil : undefined;
            }
            return snapshot();
        },
        configure: (input) =>
            serialize(async () => {
                if (input.enabled !== undefined) {
                    await deps.policy.setAuto(input.enabled);
                }
                if (input.pausedUntil !== undefined) {
                    await deps.policy.pause(input.pausedUntil === null || input.pausedUntil <= now() ? undefined : input.pausedUntil);
                }
                if (input.applyNow === true) {
                    if (phase === "updating") {
                        return snapshot();
                    }
                    const target = takeableVersion(await deps.offer());
                    if (target === undefined) {
                        throw new Error("There is no downloaded update to take right now.");
                    }
                    const host = await deps.host(true);
                    if (host === undefined) {
                        throw new Error("The machine that runs this sandbox is not connected, so nothing here can ask it to update.");
                    }
                    // A person asked: no countdown, no hold, and none of the last try's wait.
                    version = target;
                    failure = undefined;
                    void apply(target, host).catch((error: unknown) => deps.logger.warn({ err: error }, "auto-update: taking the update now failed"));
                    return snapshot();
                }
                await look();
                return snapshot();
            }),
        // Coalesced: a roster that churns while tabs reconnect is one look, not one per frame.
        poke: () => {
            if (pokeTimer !== undefined) {
                return;
            }
            pokeTimer = setTimeout(() => {
                pokeTimer = undefined;
                lookSoon();
            }, 1_000);
            pokeTimer.unref?.();
        },
        stop: () => {
            stopped = true;
            clearInterval(poller);
            clearCountdown();
            clearTimeout(graceTimer);
            clearTimeout(pokeTimer);
        },
    };
};

// The one running in this daemon, for the routes that read and steer it; undefined wherever it does not run. Held here,
// below every subsystem, so a route reaches it without importing the boot wiring that starts it (bootstrap/update-when-quiet.ts).
let running: AutoUpdater | undefined;
export const autoUpdater = (): AutoUpdater | undefined => running;
// Installs the started one; the returned release forgets it, unless another has been installed since.
export const holdAutoUpdater = (updater: AutoUpdater): (() => void) => {
    running = updater;
    return () => {
        if (running === updater) {
            running = undefined;
        }
    };
};
