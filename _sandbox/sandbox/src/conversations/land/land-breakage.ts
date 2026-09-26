import { join } from "node:path";
import { type AgentSummary, fixAttemptOf, landBreakagePrompt, landFixConversationId, type MainlineRouting } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import { deliverWake } from "../../agent/run/turn/wake-delivery.js";
import { conversationProfile, isIsolated, type PersistedAgent, reposOf } from "../registry/agents-store.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import type { LandBreakage } from "../../workspace/deps/verify-deps.js";
import type { Carried, Streak } from "../../workspace/deps/verify-store.js";
import { findingOfUnit, pathOfUnit } from "../../workspace/deps/failure-units.js";
import { readWorkspaceManifests } from "../../workspace/deps/package-graph.js";
import { landingPaths } from "./landing-paths.js";
import { landChange, type LandSuspect, narrowCheckOf, startLandFix } from "./land-fix.js";

/* WHAT A RED MAIN-LINE CHECK IS OWED. Nothing checks inside a turn, so this is where a failure meets the work that caused
   it, decided in the order that wastes the least:
   1. more work landed while the check ran: wait for the check that measures it too, which may already be green;
   2. a conversation still working touches what failed: wait for it to stop, and tell it, rather than start a competitor;
   3. one land can be named by the paths it changed, and its conversation still has the work in mind, warm in the
      prompt cache and with room left: send it back there;
   4. otherwise a fresh conversation, handed the failures, the suspects' changes and where to read their sessions.
   Nothing is re-run to tell several suspects apart: a fresh conversation handed all of them costs one session, and
   re-running the failing suites on each suspect's own tree cost a full test run per suspect on a shared machine.
   A red streak allows a few sends and a few fresh attempts; past them it waits for a person. Every decision is filed on
   the run it answers (mainline.ts's routing kinds), which the editor shows. */

// Follow-ups one conversation is sent while one project stays red; past this the breakage is not its to keep chasing.
const SENDS_PER_STREAK = 2;
// Fresh fix-up conversations started while one project stays red, attempts at one failure counted once each.
const FIX_UPS_PER_STREAK = 2;
// How many reds in a row may wait on work landed behind them before one is routed regardless: lands arriving faster
// than the check runs must not keep a failure from ever being owed to anybody.
const WAITS_PER_STREAK = 3;
// How long a red may wait on a conversation still working before it is routed anyway.
const HOLD_MAX_MS = 45 * 60_000;
// A conversation past this share of its window is not handed more to carry.
const ROOMY_SHARE = 0.6;
// Without a published cache deadline, how recent its last activity must be to count as still in mind.
const WARM_FALLBACK_MS = 5 * 60_000;
// Failures listed in a follow-up before the rest are counted.
const LISTED = 30;

export type BreakageRouter = Pick<
    Services,
    "sandboxSettings" | "agents" | "agentWorktrees" | "activity" | "logger" | "turns" | "conversations" | "verifyStore" | "landCheck" | "workspace"
>;

// What a red carried forward, per project, while it waited or held: the failures still owed, the lands they may have
// come with, and the runs whose routing is decided with it. Kept in the verify store (`streaks`), so a restart neither
// forgets a hold nor leaves it reading "On hold" for good.
interface Owed {
    readonly breakage: LandBreakage;
    readonly runs: readonly number[];
    readonly waits: number;
    // When it first held on a conversation still working, carried across re-holds so HOLD_MAX_MS is one bound.
    readonly heldSince?: number | undefined;
    // The conversations it holds on; empty while it only waits for the next check.
    readonly on: readonly string[];
}

// The hold's bound, as a timer per project; only a wake-up, since what it wakes is read back from the store (and armed
// again at boot from `heldSince`).
const holdTimers = new Map<string, ReturnType<typeof setTimeout>>();

const clearHoldTimer = (project: string): void => {
    const timer = holdTimers.get(project);
    if (timer !== undefined) {
        clearTimeout(timer);
        holdTimers.delete(project);
    }
};

const carriedOf = (owed: Owed): Carried => ({
    command: owed.breakage.command,
    fresh: [...owed.breakage.fresh],
    failures: [...owed.breakage.failures],
    logTail: owed.breakage.logTail,
    measured: owed.breakage.measured,
    lands: [...owed.breakage.lands],
    runs: [...owed.runs],
    waits: owed.waits,
    ...(owed.heldSince === undefined ? {} : { heldSince: owed.heldSince }),
    on: [...owed.on],
});

const owedOf = (project: string, since: number, carried: Carried): Owed => ({
    breakage: {
        project,
        command: carried.command,
        lands: carried.lands,
        fresh: carried.fresh,
        failures: carried.failures,
        logTail: carried.logTail,
        runAt: carried.runs.at(-1) ?? since,
        redSince: since,
        queuedBehind: false,
        measured: carried.measured,
    },
    runs: carried.runs,
    waits: carried.waits,
    heldSince: carried.heldSince,
    on: carried.on,
});

// The project's Red for the streak that began at `since`: the one on file, or a fresh one where the file holds none or an
// earlier streak's, which is nobody's any more.
const redFor = (current: Streak | undefined, since: number): Streak =>
    current?.since === since ? current : { since, findings: [], suspects: [], named: false, decisions: [], told: [] };

// Writes (or, with undefined, drops) what the project's streak carries; the Red and the conversations told stay with it.
const carry = (services: BreakageRouter, project: string, since: number, owed: Owed | undefined): Promise<void> =>
    services.verifyStore.streak(project, (current) => {
        const { carried: _carried, ...red } = redFor(current, since);
        return owed === undefined ? red : { ...red, carried: carriedOf(owed) };
    });

// What the project's current streak carries, if anything; one left from an earlier streak is nobody's any more.
const carriedFor = async (services: BreakageRouter, project: string, since: number): Promise<{ readonly carried?: Carried; readonly told: readonly string[] }> => {
    const streak = (await services.verifyStore.streaks())[project];
    return streak?.since === since ? { ...(streak.carried === undefined ? {} : { carried: streak.carried }), told: streak.told } : { told: [] };
};

// Every decision the streak's Red holds, oldest first; none for a streak it does not hold.
const decisionsOf = async (services: BreakageRouter, project: string, since: number): Promise<readonly MainlineRouting[]> => {
    const streak = (await services.verifyStore.streaks())[project];
    return streak?.since === since ? streak.decisions : [];
};

// Follow-ups sent to one conversation this streak, as its Red's decisions say.
const sendsTo = async (services: BreakageRouter, project: string, since: number, conversationId: string): Promise<number> =>
    (await decisionsOf(services, project, since)).filter((routing) => routing.kind === "original" && routing.conversationId === conversationId).length;

// Fresh fix-up conversations this streak has had, live or archived, as the fleet's own roster numbers them.
const fixUpsOf = (services: Pick<Services, "agents">, project: string, since: number): number => {
    const base = landFixConversationId(project, since);
    const ids = new Set([...services.agents.list(), ...services.agents.listArchived()].map(({ id }) => id));
    return [...ids].filter((id) => fixAttemptOf(base, id) !== undefined).length;
};

// The package a path sits in: the deepest workspace package whose folder holds it (package-graph.ts reads them from
// pnpm-workspace.yaml), else its first two segments, which is where this layout keeps packages; the whole path when it is
// shorter.
export const packageOf = (path: string, packages: readonly string[] = []): string =>
    packages.find((dir) => path === dir || path.startsWith(`${dir}/`)) ?? path.split("/").slice(0, 2).join("/");

// The project's workspace packages, by folder, deepest first so a nested package wins over its parent; empty for a
// project that is no pnpm workspace, whose paths then fall back to their first two segments.
const packagesIn = (services: Pick<Services, "workspace">, project: string): string[] =>
    readWorkspaceManifests(join(services.workspace.root, project))
        .map(({ dir }) => dir)
        .toSorted((left, right) => right.length - left.length);

// The packages failures sit in, as repository paths name them.
export const failingPackages = (fresh: readonly string[], packages: readonly string[] = []): ReadonlySet<string> =>
    new Set(fresh.flatMap((unit) => pathOfUnit(unit) ?? []).map((path) => packageOf(path, packages)));

// Lands whose own changes touch a package some fresh failure sits in; every land when no failure names a path.
export const suspectsOf = (
    fresh: readonly string[],
    lands: readonly { readonly land: DependencyLandOrigin; readonly paths: readonly string[] }[],
    packages: readonly string[] = [],
): DependencyLandOrigin[] => {
    const named = failingPackages(fresh, packages);
    if (named.size === 0) {
        return lands.map(({ land }) => land);
    }
    return lands.filter(({ paths }) => paths.some((path) => named.has(packageOf(path, packages)))).map(({ land }) => land);
};

// Every land once, oldest first, by the conversation that landed it: a conversation landing twice is one suspect.
const distinctLands = <T extends DependencyLandOrigin>(lands: readonly T[]): T[] => {
    const seen = new Map<string, T>();
    for (const land of lands) {
        seen.set(land.agentId, { ...land, repos: [...(seen.get(land.agentId)?.repos ?? []), ...land.repos] });
    }
    return [...seen.values()];
};

// Whether a conversation still has the work in mind: its prompt cache warm, and room left in its window.
export const stillInMind = (agent: Pick<AgentSummary, "promptCache" | "contextTokens" | "contextWindow" | "updatedAt"> | undefined, now: number): boolean => {
    if (agent === undefined) {
        return false;
    }
    const cache = agent.promptCache;
    const warm =
        cache === undefined
            ? now - agent.updatedAt < WARM_FALLBACK_MS
            : now < cache.at + cache.ttlMs && (cache.rollsAt === undefined || now < cache.rollsAt);
    const roomy = agent.contextTokens === undefined || agent.contextWindow === undefined || agent.contextTokens / agent.contextWindow < ROOMY_SHARE;
    return warm && roomy;
};

// Logs what a best-effort write or decision could not do, with the fields that say where; the router goes on regardless.
const warnOn =
    (services: Pick<Services, "logger">, fields: { readonly project?: string; readonly type?: string }, message: string) =>
    (error: unknown): void =>
        services.logger.warn({ err: error, ...fields }, message);

const append = (services: BreakageRouter, type: string, content: string, land?: DependencyLandOrigin): void => {
    void services.activity
        .append({
            direction: "system",
            type,
            content,
            outcome: "ok",
            ...(land === undefined ? {} : { conversationId: land.agentId, ...(land.title === undefined ? {} : { title: land.title }) }),
        })
        .catch(warnOn(services, { type }, "land breakage: activity append failed"));
};

const where = (project: string): string => (project === "" ? "the workspace root" : project);

// The follow-up a conversation whose land broke the main tree is sent.
const followUpOf = (breakage: LandBreakage): string =>
    landBreakagePrompt([
        `\`${breakage.command}\` in ${where(breakage.project)} failed on:`,
        [...breakage.fresh.slice(0, LISTED).map((unit) => `- ${unit}`), ...(breakage.fresh.length > LISTED ? [`- …and ${breakage.fresh.length - LISTED} more`] : [])].join("\n"),
        narrowCheckOf(breakage.command),
        `The end of its output:\n\n\`\`\`\n${breakage.logTail.trim()}\n\`\`\``,
    ]);

// What a conversation still working on a failing package is told, once a streak: its work may be the fix, and nothing else
// will start on it until it stops.
const heldNoteOf = (breakage: LandBreakage, packages: readonly string[]): string =>
    [
        `The main tree's own check in ${where(breakage.project)} went red after other work landed, on ${packages.map((pkg) => `\`${pkg}\``).join(", ")}, which your unlanded work here also touches.`,
        `Nothing else is being started on it while you work. If your change already fixes it, finish as usual; the check runs again when your work lands. Its failures:`,
        breakage.fresh.slice(0, 10).map((unit) => `- ${unit}`).join("\n"),
    ].join("\n\n");

// The conversations still working whose unlanded work touches a failing package, suspects included: a suspect busy on
// something else is asked once it stops, never interrupted.
const workingOn = async (
    services: BreakageRouter,
    breakage: LandBreakage,
    packages: ReadonlySet<string>,
    suspects: readonly string[],
    workspacePackages: readonly string[],
): Promise<string[]> => {
    const repo = breakage.project === "" ? "root" : breakage.project;
    const running = services.agents.list().filter((agent) => agent.archivedAt === undefined && services.conversations.running(agent.id));
    const touching = await Promise.all(
        running.map(async (agent) => {
            if (suspects.includes(agent.id)) {
                return agent.id;
            }
            const entry = services.agents.entry(agent.id);
            if (entry === undefined || !isIsolated(entry) || packages.size === 0) {
                return undefined;
            }
            const paths = await landingPaths(services, entry, [{ repo }]);
            const inRepo = paths.map((path) => (repo === "root" ? path : path.slice(repo.length + 1)));
            return inRepo.some((path) => packages.has(packageOf(path, workspacePackages))) ? agent.id : undefined;
        }),
    );
    return touching.filter((id): id is string => id !== undefined);
};

// Files the decision in the streak's Red, once, and on every run it answers for, older ones carried in included, which the
// history the cards read keeps.
const fileRouting = async (services: BreakageRouter, project: string, since: number, runs: readonly number[], routing: MainlineRouting): Promise<void> => {
    await services.verifyStore
        .streak(project, (current) => {
            const red = redFor(current, since);
            return { ...red, decisions: [...red.decisions, routing] };
        })
        .catch(warnOn(services, { project }, "land breakage: decision not filed"));
    for (const at of runs) {
        await services.verifyStore.routed(project, at, routing).catch(warnOn(services, { project }, "land breakage: routing not filed"));
    }
};

// Files who the failures are laid at, the one place blame is decided: in the streak's Red with what it owes, and on each
// run it answers for. The editor reads it as it stands.
// A run laid at nobody (`owes` undefined: it only found main red) leaves the streak's Red as it was.
const fileBlame = async (
    services: BreakageRouter,
    project: string,
    since: number,
    runs: readonly number[],
    laid: Laid,
    owes: readonly string[] | undefined,
): Promise<void> => {
    const suspects = laid.suspects.map(({ land }) => land.agentId);
    if (owes !== undefined) {
        await services.verifyStore
            .streak(project, (current) => ({ ...redFor(current, since), findings: owes.map(findingOfUnit), suspects, named: laid.named }))
            .catch(warnOn(services, { project }, "land breakage: blame not filed"));
    }
    await services.verifyStore
        .blamed(project, runs, { suspects, named: laid.named })
        .catch(warnOn(services, { project }, "land breakage: blame not filed"));
};

// A red with nothing new in it, or no land to answer for it, is laid at nobody: it only found main red.
const NOBODY: Laid = { suspects: [], named: false };
// The landed tip a land's conversation recorded for a repository, live or parked.
const tipOf =
    (services: BreakageRouter) =>
    (land: DependencyLandOrigin, repo: string): string | undefined => {
        const entry = services.agents.entry(land.agentId);
        return entry === undefined ? undefined : reposOf(entry).find((record) => record.repo === repo)?.landedTip;
    };

// Who the failures are laid at, and whether the paths they changed narrowed it to them.
interface Laid {
    readonly suspects: readonly LandSuspect[];
    readonly named: boolean;
}

// Who the failures are laid at: the one land a run covered, else the lands whose changes touch a failing package. One
// such land is named; several, or none, go to a fresh conversation together.
const blame = async (services: BreakageRouter, breakage: LandBreakage, git: GitRunner): Promise<Laid> => {
    const changes = await Promise.all(breakage.lands.map((land) => landChange(services, land, breakage.project, tipOf(services), git)));
    if (changes.length === 1) {
        return { suspects: changes, named: true };
    }
    const byPath = suspectsOf(
        breakage.fresh,
        changes.map(({ land, paths }) => ({ land, paths })),
        packagesIn(services, breakage.project),
    );
    const suspects = changes.filter((change) => byPath.includes(change.land));
    return suspects.length === 0 ? { suspects: changes, named: false } : { suspects, named: suspects.length === 1 };
};

// Sends the failures back to the conversation that landed them; `entry` is its record, which passedOverWhy found live.
const sendBack = (services: BreakageRouter, breakage: LandBreakage, land: DependencyLandOrigin, entry: PersistedAgent, sends: number): MainlineRouting => {
    append(services, "deps.breakage_routed", `${breakage.fresh.length} failure(s) appeared with this land; sent back to it to fix (${sends + 1} of ${SENDS_PER_STREAK}).`, land);
    // A live conversation takes the words as a steer, an idle one is started, and a busy one queues them for its next turn.
    void deliverWake(
        { turns: services.turns, sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId) },
        { conversationId: land.agentId, prompt: followUpOf(breakage), voice: "sandbox", errand: "land-breakage", source: "land-breakage", profile: conversationProfile(entry) },
    ).then((receipt) => {
        if ("invalid" in receipt) {
            services.logger.warn({ conversationId: land.agentId, project: breakage.project, invalid: receipt.invalid }, "land breakage: the conversation could not take the follow-up");
        }
    });
    return { kind: "original", conversationId: land.agentId, at: Date.now(), detail: `Sent back to the conversation that landed it (${sends + 1} of ${SENDS_PER_STREAK}).` };
};

// Starts, or finds, the fresh conversation working on this streak; past the streak's allowance of attempts, as the fleet
// numbers them, it waits for a person.
const freshFixUp = async (services: Services, breakage: LandBreakage, suspects: readonly LandSuspect[], named: boolean, passedOver: string | undefined): Promise<MainlineRouting> => {
    const started = fixUpsOf(services, breakage.project, breakage.redSince);
    if (started >= FIX_UPS_PER_STREAK) {
        append(services, "deps.breakage_spent", `The main tree's check in ${where(breakage.project)} is still red after ${started} fresh attempt(s); it waits for a person.`);
        return { kind: "spent", at: Date.now(), detail: `Still red after ${started} fresh attempt(s); it waits for you.` };
    }
    try {
        const outcome = await startLandFix(services, { breakage, suspects, named, passedOver });
        if (outcome.kind === "busy") {
            return { kind: "fix-up", conversationId: outcome.conversationId, at: Date.now(), detail: "A conversation is already working on this red." };
        }
        append(
            services,
            "deps.breakage_fixup",
            `${breakage.fresh.length} failure(s) in ${where(breakage.project)} handed to a fresh conversation (${outcome.conversationId})${passedOver === undefined ? "" : `: ${passedOver}`}`,
        );
        return {
            kind: "fix-up",
            conversationId: outcome.conversationId,
            at: Date.now(),
            detail: passedOver ?? (named ? "Started a fresh conversation on it." : "No single land could be named; started a fresh conversation on it."),
        };
    } catch (error) {
        services.logger.warn({ err: error, project: breakage.project }, "land breakage: a fresh fix-up could not start");
        return { kind: "reported", at: Date.now(), detail: "A fresh conversation could not be started on it." };
    }
};

// Why the one conversation named is not the one asked, in the sandbox's words; undefined when it should be.
const passedOverWhy = (services: BreakageRouter, land: DependencyLandOrigin, sends: number, now: number): string | undefined => {
    const entry = services.agents.entry(land.agentId);
    if (entry === undefined || entry.archivedAt !== undefined) {
        return `The conversation that landed it ("${land.title ?? land.agentId}") is archived.`;
    }
    if (sends >= SENDS_PER_STREAK) {
        return `The conversation that landed it ("${land.title ?? land.agentId}") was already sent it ${SENDS_PER_STREAK} times.`;
    }
    if (!stillInMind(services.agents.get(land.agentId), now)) {
        return `The conversation that landed it ("${land.title ?? land.agentId}") has gone cold or is nearly full, so reading all of it again would cost more than starting fresh.`;
    }
    return undefined;
};

// Wakes the router when a hold runs out of time, `at` from now; the hold itself is read back from the store then.
const armHold = (services: Services, project: string, at: number): void => {
    clearHoldTimer(project);
    const timer = setTimeout(() => void release(services, project), Math.max(0, at - Date.now()));
    timer.unref();
    holdTimers.set(project, timer);
};

// Holds a red on the conversations still working on what failed, telling each one once a streak; routed when the last
// stops, or after HOLD_MAX_MS regardless.
const hold = async (services: Services, owed: Owed, on: readonly string[], packages: readonly string[]): Promise<MainlineRouting> => {
    const { breakage } = owed;
    const heldSince = owed.heldSince ?? Date.now();
    const { told } = await carriedFor(services, breakage.project, breakage.redSince);
    // A suspect is asked about its own land once it stops, never told about it mid-turn.
    const telling = on.filter((id) => !told.includes(id) && services.agents.entry(id) !== undefined && !breakage.lands.some((land) => land.agentId === id));
    await services.verifyStore.streak(breakage.project, (current) => ({
        ...redFor(current, breakage.redSince),
        told: [...told, ...telling],
        carried: carriedOf({ ...owed, heldSince, on }),
    }));
    armHold(services, breakage.project, heldSince + HOLD_MAX_MS);
    for (const id of telling) {
        const entry = services.agents.entry(id);
        if (entry === undefined) {
            continue;
        }
        void deliverWake(
            { turns: services.turns, sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId) },
            { conversationId: id, prompt: heldNoteOf(breakage, packages), voice: "sandbox", errand: "land-held", source: "land-breakage", profile: conversationProfile(entry) },
        );
    }
    append(services, "deps.breakage_held", `${breakage.fresh.length} failure(s) in ${where(breakage.project)} wait on ${on.length} conversation(s) still working on what failed.`);
    return { kind: "held", conversationId: on[0], at: Date.now(), detail: "A conversation still working touches what failed; nothing else starts until it stops." };
};

// The decision, once nothing ahead of it can change it.
const decide = async (services: Services, owed: Owed, git: GitRunner, now: number, laid?: Laid): Promise<MainlineRouting> => {
    const { breakage } = owed;
    const { suspects, named } = laid ?? (await blame(services, breakage, git));
    if (laid === undefined) {
        await fileBlame(services, breakage.project, breakage.redSince, owed.runs, { suspects, named }, breakage.fresh);
    }
    const ids = suspects.map(({ land }) => land.agentId);
    const workspacePackages = packagesIn(services, breakage.project);
    const packages = failingPackages(breakage.fresh, workspacePackages);
    // Past the bound a red is routed even while somebody works: a long session must not keep main red for hours.
    const holdOverdue = owed.heldSince !== undefined && owed.heldSince + HOLD_MAX_MS <= now;
    const busy = holdOverdue ? [] : await workingOn(services, breakage, packages, ids, workspacePackages);
    if (busy.length > 0) {
        const routing = await hold(services, owed, busy, [...packages]);
        await fileRouting(services, breakage.project, breakage.redSince, owed.runs, routing);
        return routing;
    }
    clearHoldTimer(breakage.project);
    await carry(services, breakage.project, breakage.redSince, undefined);
    const single = named && suspects.length === 1 ? suspects[0] : undefined;
    const sends = single === undefined ? 0 : await sendsTo(services, breakage.project, breakage.redSince, single.land.agentId);
    const passedOver = single === undefined ? undefined : passedOverWhy(services, single.land, sends, now);
    const entry = single === undefined ? undefined : services.agents.entry(single.land.agentId);
    const routing =
        single !== undefined && entry !== undefined && passedOver === undefined
            ? sendBack(services, breakage, single.land, entry, sends)
            : await freshFixUp(services, breakage, suspects, named, passedOver);
    await fileRouting(services, breakage.project, breakage.redSince, owed.runs, routing);
    return routing;
};

// A hold ends: its conversations stopped, or it ran out of time. Routed now unless a land it waited for is being checked,
// whose own red (or green) decides instead.
const release = async (services: Services, project: string, git: GitRunner = defaultGit): Promise<void> => {
    clearHoldTimer(project);
    const streak = (await services.verifyStore.streaks())[project];
    if (streak?.carried === undefined || streak.carried.on.length === 0) {
        return;
    }
    const owed: Owed = { ...owedOf(project, streak.since, streak.carried), on: [] };
    if (await services.landCheck.ahead(project)) {
        await carry(services, project, streak.since, owed);
        return;
    }
    await decide(services, owed, git, Date.now()).catch(warnOn(services, { project }, "land breakage: a held red could not be routed"));
};

// Folds what an earlier red left owed into this one: its failures that still fail, and every land they may have come with.
const owedWith = (breakage: LandBreakage, prior: Carried | undefined): Owed => {
    if (prior === undefined) {
        return { breakage: { ...breakage, lands: distinctLands(breakage.lands) }, runs: [breakage.runAt], waits: 0, on: [] };
    }
    // A run that named no failures cannot say which carried ones still stand, so they all do.
    const still = breakage.measured ? prior.fresh.filter((unit) => breakage.failures.includes(unit)) : prior.fresh;
    return {
        breakage: {
            ...breakage,
            fresh: [...new Set([...still, ...breakage.fresh])],
            lands: distinctLands([...prior.lands, ...breakage.lands]),
        },
        runs: [...prior.runs, breakage.runAt],
        waits: prior.waits,
        heldSince: prior.heldSince,
        on: [],
    };
};

// What a red run's failures are owed; undefined when nothing new appeared and nothing was carried, or no land is there to
// answer for them (a causeless install), which leaves them to any chore.
export const routeLandBreakage = async (services: Services, breakage: LandBreakage, git: GitRunner = defaultGit): Promise<MainlineRouting | undefined> => {
    const now = Date.now();
    const project = breakage.project;
    clearHoldTimer(project);
    const owed = owedWith(breakage, (await carriedFor(services, project, breakage.redSince)).carried);
    if (owed.breakage.fresh.length === 0 || owed.breakage.lands.length === 0) {
        await carry(services, project, breakage.redSince, undefined);
        // What an earlier red carried in is gone at this one, though the tree is red on something older: those runs
        // were resolved without anybody sent.
        if (owed.runs.length > 1 && owed.breakage.fresh.length === 0) {
            await fileRouting(services, project, breakage.redSince, owed.runs.slice(0, -1), { kind: "resolved", at: now, detail: "Gone at the next check, before anybody was sent." });
        }
        await fileBlame(services, project, breakage.redSince, [breakage.runAt], NOBODY, undefined);
        return undefined;
    }
    // Laid once, as soon as the run settles, whatever is decided about it: every run it answers for carries the answer.
    const laid = await blame(services, owed.breakage, git);
    await fileBlame(services, project, breakage.redSince, owed.runs, laid, owed.breakage.fresh);
    if (!(await services.sandboxSettings.get()).autoRepair) {
        await carry(services, project, breakage.redSince, undefined);
        const routing: MainlineRouting = { kind: "reported", at: now, detail: "Repairs after landing are switched off." };
        await fileRouting(services, project, breakage.redSince, owed.runs, routing);
        return routing;
    }
    if (breakage.queuedBehind && owed.waits < WAITS_PER_STREAK) {
        await carry(services, project, breakage.redSince, { ...owed, waits: owed.waits + 1 });
        append(services, "deps.breakage_waiting", `${owed.breakage.fresh.length} failure(s) in ${where(project)} wait for the check of the work that landed meanwhile.`);
        const routing: MainlineRouting = { kind: "waiting", at: now, detail: "More work landed while this ran; its check decides before anybody is sent." };
        await fileRouting(services, project, breakage.redSince, [breakage.runAt], routing);
        return routing;
    }
    // Filed on every run it answers for, the one just settled included, so a red held now and routed later reads its
    // final answer wherever the editor looks.
    return decide(services, owed, git, now, laid);
};

// A conversation's run ended: a red held on it is routed once nothing else it waits on is still working.
export const breakageRunSettled = async (services: Services, conversationId: string): Promise<void> => {
    for (const [project, streak] of Object.entries(await services.verifyStore.streaks())) {
        const carried = streak.carried;
        if (carried === undefined || !carried.on.includes(conversationId)) {
            continue;
        }
        const on = carried.on.filter((id) => id !== conversationId && services.conversations.running(id));
        if (on.length > 0) {
            await services.verifyStore.streak(project, (current) => (current?.carried === undefined ? current : { ...current, carried: { ...current.carried, on } }));
            continue;
        }
        await release(services, project);
    }
};

// A green project starts everything over, and what it had waiting is resolved without anybody sent.
export const breakageSettled = async (
    services: Pick<Services, "verifyStore" | "logger" | "activity" | "agents">,
    project: string,
    redSince: number | undefined,
): Promise<void> => {
    clearHoldTimer(project);
    const streak = (await services.verifyStore.streaks())[project];
    await services.verifyStore.streak(project, () => undefined);
    if (streak?.carried !== undefined) {
        const routing: MainlineRouting = { kind: "resolved", at: Date.now(), detail: "Green at the next check, before anybody was sent." };
        for (const at of streak.carried.runs) {
            await services.verifyStore.routed(project, at, routing).catch(warnOn(services, { project }, "land breakage: routing not filed"));
        }
        append(services as BreakageRouter, "deps.breakage_resolved", `The failures in ${where(project)} were gone at the next check; nobody was sent.`);
    }
    const since = redSince ?? streak?.since;
    if (since !== undefined) {
        const routed = (streak?.since === since ? streak.decisions : []).filter(
            ({ kind }) => kind === "original" || kind === "fix-up" || kind === "spent",
        ).length;
        // The measure of this design: how long main stays red, and how many repairs it took.
        services.logger.info({ project, redMs: Date.now() - since, routed, fixUps: fixUpsOf(services, project, since) }, "mainline: red streak ended");
    }
};

// At boot, what the daemon was holding or waiting on when it stopped is decided again: a hold on conversations no longer
// running is released, one still standing gets its timer back, and a wait with no check left ahead of it is decided now.
export const resumeBreakageRouter = async (services: Services, git: GitRunner = defaultGit): Promise<void> => {
    const { projects } = await services.verifyStore.read();
    for (const [project, streak] of Object.entries(await services.verifyStore.streaks())) {
        const outcome = projects[project];
        // A streak the project is no longer in (green since, or a newer streak) has nothing left to decide.
        if (outcome?.status !== "red" || (outcome.since ?? outcome.at) !== streak.since) {
            await services.verifyStore.streak(project, () => undefined);
            continue;
        }
        const carried = streak.carried;
        if (carried === undefined) {
            continue;
        }
        if (carried.on.length > 0) {
            const on = carried.on.filter((id) => services.conversations.running(id));
            if (on.length === 0) {
                await release(services, project, git);
                continue;
            }
            await services.verifyStore.streak(project, (current) => (current?.carried === undefined ? current : { ...current, carried: { ...current.carried, on } }));
            armHold(services, project, (carried.heldSince ?? Date.now()) + HOLD_MAX_MS);
            continue;
        }
        if (!(await services.landCheck.ahead(project))) {
            await decide(services, owedOf(project, streak.since, carried), git, Date.now()).catch(warnOn(services, { project }, "land breakage: a waiting red could not be routed"));
        }
    }
};

// Test seam: stops every hold's timer.
export const resetBreakageRouter = (): void => {
    for (const project of holdTimers.keys()) {
        clearHoldTimer(project);
    }
};
