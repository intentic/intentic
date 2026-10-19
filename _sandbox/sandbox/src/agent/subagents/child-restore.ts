import { parentOfActor } from "../../auth/principal.js";
import type { Services } from "../../composition.js";
import { liveRunOf } from "../../conversations/actor/conversation-holdings.js";
import { ROSTER } from "../../conversations/actor/subagent-roster.js";
import { sayToParent } from "../../conversations/land/child-lands.js";
import { opt } from "../../opt.js";
import { bindChildFile, CHILDREN, keepChild, ledgerOf, SEATS, settleChild } from "./child-records.js";
import { childRecordOf, childRouting, taskLine } from "./child-spec.js";
import { type ChildRecord, followAdopted, resumeHeldChild, rosterHandle } from "./children.js";
import { labelOf } from "./child-gates.js";
import { restoredFate, type SpawnedChild, specFromFile } from "./spawned-children.js";
import { type RestoredChildRow, restoreSpawnedChild } from "./roster-restore.js";

// A parent's children brought back at boot from their files (spawned-children.ts), before any turn the restart cut can
// resume, and the ones whose cut turn never came back settled once the resume pass ran (boot-resumes.ts).

// What a restored child's row says while the boot waits to see whether the turn a restart cut comes back.
const RESTARTED_SUMMARY = "The sandbox restarted during its turn: waiting to see whether the turn resumes.";

// Why a restored child whose turn did not come back stays stopped, as its row and its parent read it.
export const RESTART_CUT = "The sandbox restarted during its turn and did not pick the turn back up. Its work so far stays in its worktree: send it a message to carry on, or cancel it.";
const restartCutPause = (failure: string): string =>
    `${failure} The sandbox restarted before the re-run it had booked, so it is not coming back by itself: send it a message to carry on, or cancel it.`;

// A child's record as its file brings it back: nothing running yet, since a turn that resumes is adopted (adoptChildTurn).
const restoredRecord = (entry: SpawnedChild): ChildRecord => {
    const kid = childRecordOf({ conversationId: entry.parent, cwd: entry.cwd }, specFromFile(entry.spec), entry.depth);
    kid.running = false;
    kid.startedAt = entry.startedAt;
    kid.sessionId = entry.sessionId;
    kid.report = entry.report;
    kid.result = entry.result;
    kid.turns = entry.turns;
    kid.startHold = entry.startHold;
    kid.held = entry.startHold?.kind;
    return kid;
};

// Its roster row as its file brings it back. An ending from before the restart counts as handed over, so a wait on "any"
// does not hand it out again; a wait naming the child still answers with it.
const restoredRow = (id: string, entry: SpawnedChild): RestoredChildRow => {
    const spec = specFromFile(entry.spec);
    const { provider, model } = childRouting(spec);
    const birth = { id, description: taskLine(spec), agentType: labelOf(provider), provider, model, spawnDepth: entry.depth, startedAt: entry.startedAt };
    if (entry.state === "held") {
        return { ...birth, status: "pending", summary: `Waiting to start: ${entry.startHold?.kind ?? "unknown hold"}.` };
    }
    if (entry.state === "running") {
        return { ...birth, status: "pending", summary: RESTARTED_SUMMARY };
    }
    if (entry.state === "paused") {
        return { ...birth, status: "paused", summary: `Paused, not finished. ${entry.pausedOn ?? ""}`.trim(), ...opt("error", entry.pausedOn) };
    }
    const ending = entry.ending;
    return {
        ...birth,
        status: ending?.status ?? "completed",
        endedAt: ending?.at ?? entry.at,
        ...opt("summary", ending?.summary),
        ...opt("error", ending?.error),
        ...opt("verification", ending?.verification),
    };
};

/**
 * At boot, before any interrupted turn resumes: brings back every child a parent still supervises, its record and its
 * roster row, and strikes off the rest. Answers the ones whose turn the restart cut (running or paused when it went
 * down), for settleRestoredChildren to look at once the resumes ran. Never throws.
 */
export const restoreSpawnedChildren = async (services: Services): Promise<readonly string[]> => {
    const cut: string[] = [];
    try {
        const ledger = ledgerOf(services);
        const now = Date.now();
        for (const entry of (await ledger.list()).toSorted((left, right) => (left.startHold?.order ?? 0) - (right.startHold?.order ?? 0))) {
            const child = services.agents.entry(entry.id);
            const parent = services.agents.entry(entry.parent);
            const fate = restoredFate(entry, {
                child: child === undefined ? undefined : { parent: parentOfActor(child.identity.startedBy) },
                parent: parent === undefined ? undefined : { archived: parent.archivedAt !== undefined },
            }, now);
            if (fate.kind === "drop") {
                ledger.forget(entry.id);
                services.logger.info({ child: entry.id, parent: entry.parent, why: fate.why }, "subagents: a spawned child on file, struck off at boot");
                continue;
            }
            if (services.conversations.holdings(CHILDREN).has(entry.id)) {
                continue;
            }
            const kid = restoredRecord(entry);
            bindChildFile(services, entry.id, kid);
            services.conversations.holdings(CHILDREN).hold(entry.parent, entry.id, kid, entry.id);
            restoreSpawnedChild(rosterHandle(services, entry.parent), restoredRow(entry.id, entry));
            // The parent's lifetime budget counts what it already spent; nothing of it runs until a turn is adopted.
            const seats = services.conversations.holdings(SEATS);
            const reserved = entry.startHold?.kind === "lane" ? 1 : 0;
            const before = seats.get(entry.parent) ?? { live: 0, total: 0 };
            seats.hold(entry.parent, entry.parent, { live: before.live + reserved, total: before.total + entry.turns + reserved });
            if (entry.state !== "settled") {
                cut.push(entry.id);
            }
        }
    } catch (error) {
        services.logger.warn({ err: error }, "subagents: spawned children could not be read back, their parents cannot reach them after this restart");
    }
    return cut;
};

// One child a restart cut: its resumed turn is followed, a booked re-run is waited for, and the rest stay stopped. A
// held start is left for the second pass in settleRestoredChildren.
const settleCutChild = (services: Services, childId: string): void => {
    const kid = services.conversations.holdings(CHILDREN).get(childId);
    if (kid === undefined || kid.running || kid.startHold !== undefined) {
        return;
    }
    const run = liveRunOf(services.conversations, childId);
    if (run !== undefined) {
        followAdopted(services, childId, kid, run);
        return;
    }
    const held = services.conversations.state(childId)?.resume.held;
    if (held !== undefined && !held.fired) {
        return;
    }
    const paused = services.conversations.holdings(ROSTER).get(childId)?.status === "paused";
    const error = paused ? restartCutPause(services.conversations.holdings(ROSTER).get(childId)?.error ?? "") : RESTART_CUT;
    settleChild(services.conversations, childId, { status: "failed", report: kid.report ?? "", error });
    keepChild(services, childId);
    if (!paused) {
        void sayToParent(services, kid.parent, `Your subagent \`${childId}\` ("${taskLine(kid.spec)}") stays stopped: ${RESTART_CUT}`);
    }
};

/**
 * Once the turns a restart cut were resumed: each restored child whose turn came back is followed like any adopted turn;
 * one with a re-run still booked waits for it; the rest stay stopped, said on their rows and, for a turn that was under
 * way, to a parent with a live turn (a paused one's parent hears it from paused-children.ts). Never throws.
 */
export const settleRestoredChildren = async (services: Services, cut: readonly string[]): Promise<void> => {
    for (const childId of cut) {
        try {
            settleCutChild(services, childId);
        } catch (error) {
            services.logger.warn({ err: error, child: childId }, "subagents: a child a restart cut could not be settled");
        }
    }
    // Adopt every resumed turn before releasing waits, so neither a parent's nor a provider's cap is undercounted.
    for (const childId of cut) {
        const kid = services.conversations.holdings(CHILDREN).get(childId);
        if (kid?.startHold === undefined) {
            continue;
        }
        try {
            await resumeHeldChild(services, childId, kid);
        } catch (error) {
            services.logger.warn({ err: error, child: childId }, "subagents: a held child could not be re-armed after restart");
        }
    }
};
