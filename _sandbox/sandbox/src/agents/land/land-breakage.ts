import { type AgentSummary, landBreakagePrompt, type MainlineRouting } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import { deliverWake } from "../../agent/run/turn/wake-delivery.js";
import { conversationProfile, isIsolated, type PersistedAgent, reposOf } from "../registry/agents-store.js";
import type { DependencyLandOrigin } from "../../workspace/deps/dependency-origin.js";
import { landCheckAhead, type LandBreakage } from "../../workspace/deps/verify-deps.js";
import { landingPaths } from "./landing-paths.js";
import { bisectSuspects } from "./land-bisect.js";
import { landChange, type LandSuspect, narrowCheckOf, startLandFix } from "./land-fix.js";

/* WHAT A RED MAIN-LINE CHECK IS OWED. Nothing checks inside a turn, so this is where a failure meets the work that caused
   it, decided in the order that wastes the least:
   1. more work landed while the check ran: wait for the check that measures it too, which may already be green;
   2. a conversation still working touches what failed: wait for it to stop, and tell it, rather than start a competitor;
   3. one land can be named (by the paths it changed, or by re-running the failures on each suspect's own tree) and its
      conversation still has the work in mind, warm in the prompt cache and with room left: send it back there;
   4. otherwise a fresh conversation, handed the failures, the suspects' changes and where to read their sessions.
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
    "sandboxSettings" | "agents" | "agentWorktrees" | "activity" | "logger" | "turns" | "conversations" | "verifyStore"
>;

// What a red carried forward, per project, while it waited: the failures still owed, the lands they may have come with,
// and the runs whose routing is decided with it.
interface Owed {
    readonly breakage: LandBreakage;
    readonly runs: readonly number[];
    readonly waits: number;
    // When it first waited on a conversation still working, carried across re-holds so HOLD_MAX_MS is one bound.
    readonly heldSince?: number | undefined;
}

// A red waiting on conversations still working, per project.
interface Held extends Owed {
    readonly on: ReadonlySet<string>;
    readonly timer: ReturnType<typeof setTimeout>;
}

const waiting = new Map<string, Owed>();
const holding = new Map<string, Held>();
// Sends per project and conversation, fresh attempts per project, and live conversations told, since it was last green.
const sent = new Map<string, number>();
const fixUps = new Map<string, number>();
const told = new Set<string>();
// When each project's red streak began and how it was answered, for the line the streak's end logs.
const streaks = new Map<string, { readonly since: number; routed: number }>();

const pairKey = (project: string, conversationId: string): string => `${project}\n${conversationId}`;

// The first repository path a unit names; a task id (`@scope/name#task`) is a package name, never a path.
export const pathOfUnit = (unit: string): string | undefined =>
    unit
        .split(/\s+/)
        .map((word) => word.replace(/:$/, ""))
        .find((word) => word.includes("/") && !word.includes("#") && !word.startsWith("@"));

// The package a path sits in, `_area/package` in this layout; the whole path when it is shorter.
export const packageOf = (path: string): string => path.split("/").slice(0, 2).join("/");

// The packages failures sit in, as repository paths name them.
export const failingPackages = (fresh: readonly string[]): ReadonlySet<string> =>
    new Set(fresh.flatMap((unit) => pathOfUnit(unit) ?? []).map(packageOf));

// Lands whose own changes touch a package some fresh failure sits in; every land when no failure names a path.
export const suspectsOf = (fresh: readonly string[], lands: readonly { readonly land: DependencyLandOrigin; readonly paths: readonly string[] }[]): DependencyLandOrigin[] => {
    const named = failingPackages(fresh);
    if (named.size === 0) {
        return lands.map(({ land }) => land);
    }
    return lands.filter(({ paths }) => paths.some((path) => named.has(packageOf(path)))).map(({ land }) => land);
};

// Every land once, oldest first, by the conversation that landed it: a conversation landing twice is one suspect.
const distinctLands = (lands: readonly DependencyLandOrigin[]): DependencyLandOrigin[] => {
    const seen = new Map<string, DependencyLandOrigin>();
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

const append = (services: BreakageRouter, type: string, content: string, land?: DependencyLandOrigin): void => {
    void services.activity
        .append({
            direction: "system",
            type,
            content,
            outcome: "ok",
            ...(land === undefined ? {} : { conversationId: land.agentId, ...(land.title === undefined ? {} : { title: land.title }) }),
        })
        .catch((error: unknown) => services.logger.warn({ err: error, type }, "land breakage: activity append failed"));
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
const workingOn = async (services: BreakageRouter, breakage: LandBreakage, packages: ReadonlySet<string>, suspects: readonly string[]): Promise<string[]> => {
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
            return inRepo.some((path) => packages.has(packageOf(path))) ? agent.id : undefined;
        }),
    );
    return touching.filter((id): id is string => id !== undefined);
};

// Files the decision on every run it answers for, older ones carried in included.
const fileRouting = async (services: BreakageRouter, project: string, runs: readonly number[], routing: MainlineRouting, suspects: readonly string[]): Promise<void> => {
    for (const at of runs) {
        await services.verifyStore
            .routed(project, at, routing, suspects)
            .catch((error: unknown) => services.logger.warn({ err: error, project }, "land breakage: routing not filed"));
    }
};

// The landed tip a land's conversation recorded for a repository, live or parked.
const tipOf =
    (services: BreakageRouter) =>
    (land: DependencyLandOrigin, repo: string): string | undefined => {
        const entry = services.agents.entry(land.agentId);
        return entry === undefined ? undefined : reposOf(entry).find((record) => record.repo === repo)?.landedTip;
    };

// Who the failures are laid at: the one land a run covered, the lands whose changes touch a failing package, and, when
// several still do and the check named a re-run, the ones whose own tree reproduces the failures.
const blame = async (services: BreakageRouter, breakage: LandBreakage, git: GitRunner): Promise<{ readonly suspects: LandSuspect[]; readonly named: boolean }> => {
    const changes = await Promise.all(breakage.lands.map((land) => landChange(services, land, breakage.project, tipOf(services), git)));
    if (changes.length === 1) {
        return { suspects: changes, named: true };
    }
    const byPath = suspectsOf(
        breakage.fresh,
        changes.map(({ land, paths }) => ({ land, paths })),
    );
    const suspects = changes.filter((change) => byPath.includes(change.land));
    if (suspects.length === 1 || breakage.rerun === undefined) {
        return suspects.length === 0 ? { suspects: changes, named: false } : { suspects, named: suspects.length === 1 };
    }
    const bisected = await bisectSuspects(services, {
        project: breakage.project,
        suspects: suspects.length === 0 ? changes : suspects,
        failures: breakage.fresh,
        rerun: breakage.rerun,
    });
    if (bisected !== undefined) {
        return { suspects: bisected, named: bisected.length === 1 };
    }
    return suspects.length === 0 ? { suspects: changes, named: false } : { suspects, named: false };
};

// Sends the failures back to the conversation that landed them; `entry` is its record, which passedOverWhy found live.
const sendBack = (services: BreakageRouter, breakage: LandBreakage, land: DependencyLandOrigin, entry: PersistedAgent, sends: number): MainlineRouting => {
    sent.set(pairKey(breakage.project, land.agentId), sends + 1);
    append(services, "deps.breakage_routed", `${breakage.fresh.length} failure(s) appeared with this land; sent back to it to fix (${sends + 1} of ${SENDS_PER_STREAK}).`, land);
    // A live conversation takes the words as a steer, an idle one is started, and a busy one queues them for its next turn.
    void deliverWake(
        { turns: services.turns, sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId) },
        { conversationId: land.agentId, prompt: followUpOf(breakage), voice: "sandbox", profile: conversationProfile(entry) },
    ).then((receipt) => {
        if ("invalid" in receipt) {
            services.logger.warn({ conversationId: land.agentId, project: breakage.project, invalid: receipt.invalid }, "land breakage: the conversation could not take the follow-up");
        }
    });
    return { kind: "original", conversationId: land.agentId, at: Date.now(), detail: `Sent back to the conversation that landed it (${sends + 1} of ${SENDS_PER_STREAK}).` };
};

// Starts, or finds, the fresh conversation working on this streak.
const freshFixUp = async (services: Services, breakage: LandBreakage, suspects: readonly LandSuspect[], named: boolean, passedOver: string | undefined): Promise<MainlineRouting> => {
    const started = fixUps.get(breakage.project) ?? 0;
    if (started >= FIX_UPS_PER_STREAK) {
        append(services, "deps.breakage_spent", `The main tree's check in ${where(breakage.project)} is still red after ${started} fresh attempt(s); it waits for a person.`);
        return { kind: "spent", at: Date.now(), detail: `Still red after ${started} fresh attempt(s); it waits for you.` };
    }
    try {
        const outcome = await startLandFix(services, { breakage, suspects, named, passedOver });
        if (outcome.kind === "busy") {
            return { kind: "fix-up", conversationId: outcome.conversationId, at: Date.now(), detail: "A conversation is already working on this red." };
        }
        fixUps.set(breakage.project, started + 1);
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
const passedOverWhy = (services: BreakageRouter, land: DependencyLandOrigin, project: string, now: number): string | undefined => {
    const entry = services.agents.entry(land.agentId);
    if (entry === undefined || entry.archivedAt !== undefined) {
        return `The conversation that landed it ("${land.title ?? land.agentId}") is archived.`;
    }
    if ((sent.get(pairKey(project, land.agentId)) ?? 0) >= SENDS_PER_STREAK) {
        return `The conversation that landed it ("${land.title ?? land.agentId}") was already sent it ${SENDS_PER_STREAK} times.`;
    }
    if (!stillInMind(services.agents.get(land.agentId), now)) {
        return `The conversation that landed it ("${land.title ?? land.agentId}") has gone cold or is nearly full, so reading all of it again would cost more than starting fresh.`;
    }
    return undefined;
};

// Holds a red on the conversations still working on what failed, telling each one once; routed when the last stops, or
// after HOLD_MAX_MS regardless.
const hold = (services: Services, owed: Owed, on: readonly string[], packages: readonly string[]): MainlineRouting => {
    const { breakage } = owed;
    const previous = holding.get(breakage.project);
    if (previous !== undefined) {
        clearTimeout(previous.timer);
    }
    const timer = setTimeout(() => void release(services, breakage.project), HOLD_MAX_MS);
    timer.unref();
    holding.set(breakage.project, { ...owed, heldSince: owed.heldSince ?? previous?.heldSince ?? Date.now(), on: new Set(on), timer });
    for (const id of on) {
        const key = pairKey(breakage.project, id);
        const entry = services.agents.entry(id);
        // A suspect is asked about its own land once it stops, never told about it mid-turn.
        if (told.has(key) || entry === undefined || breakage.lands.some((land) => land.agentId === id)) {
            continue;
        }
        told.add(key);
        void deliverWake(
            { turns: services.turns, sessionIdOf: (conversationId) => services.conversations.sessionIdOf(conversationId) },
            { conversationId: id, prompt: heldNoteOf(breakage, packages), voice: "sandbox", profile: conversationProfile(entry) },
        );
    }
    append(services, "deps.breakage_held", `${breakage.fresh.length} failure(s) in ${where(breakage.project)} wait on ${on.length} conversation(s) still working on what failed.`);
    return { kind: "held", conversationId: on[0], at: Date.now(), detail: "A conversation still working touches what failed; nothing else starts until it stops." };
};

// The decision, once nothing ahead of it can change it.
const decide = async (services: Services, owed: Owed, git: GitRunner, now: number): Promise<MainlineRouting> => {
    const { breakage } = owed;
    const { suspects, named } = await blame(services, breakage, git);
    const ids = suspects.map(({ land }) => land.agentId);
    const packages = failingPackages(breakage.fresh);
    // Past the bound a red is routed even while somebody works: a long session must not keep main red for hours.
    const holdOverdue = owed.heldSince !== undefined && owed.heldSince + HOLD_MAX_MS <= now;
    const busy = holdOverdue ? [] : await workingOn(services, breakage, packages, ids);
    if (busy.length > 0) {
        const routing = hold(services, owed, busy, [...packages]);
        await fileRouting(services, breakage.project, owed.runs, routing, ids);
        return routing;
    }
    const single = named && suspects.length === 1 ? suspects[0] : undefined;
    const passedOver = single === undefined ? undefined : passedOverWhy(services, single.land, breakage.project, now);
    const entry = single === undefined ? undefined : services.agents.entry(single.land.agentId);
    const routing =
        single !== undefined && entry !== undefined && passedOver === undefined
            ? sendBack(services, breakage, single.land, entry, sent.get(pairKey(breakage.project, single.land.agentId)) ?? 0)
            : await freshFixUp(services, breakage, suspects, named, passedOver);
    const streak = streaks.get(breakage.project);
    if (streak !== undefined) {
        streak.routed += 1;
    }
    await fileRouting(services, breakage.project, owed.runs, routing, ids);
    return routing;
};

// A hold ends: its conversations stopped, or it ran out of time. Routed now unless a land it waited for is being checked,
// whose own red (or green) decides instead.
const release = async (services: Services, project: string, git: GitRunner = defaultGit): Promise<void> => {
    const held = holding.get(project);
    if (held === undefined) {
        return;
    }
    holding.delete(project);
    clearTimeout(held.timer);
    const owed: Owed = { breakage: held.breakage, runs: held.runs, waits: held.waits, heldSince: held.heldSince };
    if (landCheckAhead(project)) {
        waiting.set(project, owed);
        return;
    }
    await decide(services, owed, git, Date.now()).catch((error: unknown) =>
        services.logger.warn({ err: error, project }, "land breakage: a held red could not be routed"),
    );
};

// Folds what an earlier red left owed into this one: its failures that still fail, and every land they may have come with.
const owedWith = (breakage: LandBreakage): Owed => {
    const prior = waiting.get(breakage.project) ?? holding.get(breakage.project);
    waiting.delete(breakage.project);
    const held = holding.get(breakage.project);
    if (held !== undefined) {
        clearTimeout(held.timer);
        holding.delete(breakage.project);
    }
    if (prior === undefined) {
        return { breakage: { ...breakage, lands: distinctLands(breakage.lands) }, runs: [breakage.runAt], waits: 0 };
    }
    // A run that named no failures cannot say which carried ones still stand, so they all do.
    const still = breakage.measured ? prior.breakage.fresh.filter((unit) => breakage.failures.includes(unit)) : prior.breakage.fresh;
    return {
        breakage: {
            ...breakage,
            fresh: [...new Set([...still, ...breakage.fresh])],
            lands: distinctLands([...prior.breakage.lands, ...breakage.lands]),
        },
        runs: [...prior.runs, breakage.runAt],
        waits: prior.waits,
        heldSince: prior.heldSince,
    };
};

// What a red run's failures are owed; undefined when nothing new appeared and nothing was carried, or no land is there to
// answer for them (a causeless install), which leaves them to any chore.
export const routeLandBreakage = async (services: Services, breakage: LandBreakage, git: GitRunner = defaultGit): Promise<MainlineRouting | undefined> => {
    const now = Date.now();
    if (!streaks.has(breakage.project)) {
        streaks.set(breakage.project, { since: breakage.redSince, routed: 0 });
    }
    const owed = owedWith(breakage);
    if (owed.breakage.fresh.length === 0 || owed.breakage.lands.length === 0) {
        // What an earlier red carried in is gone at this one, though the tree is red on something older: those runs
        // were resolved without anybody sent.
        if (owed.runs.length > 1 && owed.breakage.fresh.length === 0) {
            await fileRouting(services, breakage.project, owed.runs.slice(0, -1), { kind: "resolved", at: now, detail: "Gone at the next check, before anybody was sent." }, []);
        }
        return undefined;
    }
    if (!(await services.sandboxSettings.get()).autoRepair) {
        const routing: MainlineRouting = { kind: "reported", at: now, detail: "Repairs after landing are switched off." };
        await fileRouting(services, breakage.project, owed.runs.slice(0, -1), routing, []);
        return routing;
    }
    if (breakage.queuedBehind && owed.waits < WAITS_PER_STREAK) {
        waiting.set(breakage.project, { ...owed, waits: owed.waits + 1 });
        append(services, "deps.breakage_waiting", `${owed.breakage.fresh.length} failure(s) in ${where(breakage.project)} wait for the check of the work that landed meanwhile.`);
        return { kind: "waiting", at: now, detail: "More work landed while this ran; its check decides before anybody is sent." };
    }
    // Filed on every run it answers for, the one just settled included, so a red held now and routed later reads its
    // final answer wherever the editor looks.
    return decide(services, owed, git, now);
};

// A conversation's run ended: a red held on it is routed once nothing else it waits on is still working.
export const breakageRunSettled = (services: Services, conversationId: string): void => {
    for (const [project, held] of holding) {
        if (!held.on.has(conversationId)) {
            continue;
        }
        const on = new Set([...held.on].filter((id) => id !== conversationId && services.conversations.running(id)));
        if (on.size > 0) {
            holding.set(project, { ...held, on });
            continue;
        }
        void release(services, project);
    }
};

// A green project starts everything over, and what it had waiting is resolved without anybody sent.
export const breakageSettled = (services: Pick<Services, "verifyStore" | "logger" | "activity">, project: string): void => {
    const owed = waiting.get(project) ?? holding.get(project);
    waiting.delete(project);
    const held = holding.get(project);
    if (held !== undefined) {
        clearTimeout(held.timer);
        holding.delete(project);
    }
    if (owed !== undefined) {
        const routing: MainlineRouting = { kind: "resolved", at: Date.now(), detail: "Green at the next check, before anybody was sent." };
        void (async () => {
            for (const at of owed.runs) {
                await services.verifyStore.routed(project, at, routing).catch((error: unknown) => services.logger.warn({ err: error, project }, "land breakage: routing not filed"));
            }
        })();
        append(services as BreakageRouter, "deps.breakage_resolved", `The failures in ${where(project)} were gone at the next check; nobody was sent.`);
    }
    const streak = streaks.get(project);
    if (streak !== undefined) {
        // The measure of this design: how long main stays red, and how many repairs it took.
        services.logger.info(
            { project, redMs: Date.now() - streak.since, routed: streak.routed, fixUps: fixUps.get(project) ?? 0 },
            "mainline: red streak ended",
        );
        streaks.delete(project);
    }
    fixUps.delete(project);
    for (const key of sent.keys()) {
        if (key.startsWith(`${project}\n`)) {
            sent.delete(key);
        }
    }
    for (const key of told) {
        if (key.startsWith(`${project}\n`)) {
            told.delete(key);
        }
    }
};

// Test seam: forgets every project's streak.
export const resetBreakageRouter = (): void => {
    for (const held of holding.values()) {
        clearTimeout(held.timer);
    }
    waiting.clear();
    holding.clear();
    sent.clear();
    fixUps.clear();
    told.clear();
    streaks.clear();
};
