import type { SessionModeState } from "@agentclientprotocol/sdk";
import type { PermissionMode } from "@intentic/sandbox-contract";

// An ACP session's modes (NewSessionResponse.modes, session/set_mode, current_mode_update), and which of them a turn's
// posture maps onto. The protocol fixes no mode ids, so the match is by id or name: Claude Code's adapter names
// `default`/`plan`/`bypassPermissions`, Devin's CLI `accept-edits`/`smart`/`ask`/`plan`/`bypass`, Gemini's `yolo`,
// Codex's adapter `full-access`. An agent advertising none keeps its own posture, and the daemon's emulations stand in.

export interface SessionModes {
    // What the session is in now, kept current by current_mode_update.
    readonly current: string;
    readonly available: readonly { readonly id: string; readonly name: string }[];
    // The mode a turn that asks for no special posture runs in: the agent's own default as the session first stated it,
    // unless that was a plan or bypass mode, whose posture no such turn asked for.
    readonly home: string;
}

// Lower-cased, punctuation and spacing dropped, so `Bypass Permissions`, `bypassPermissions` and `bypass-permissions`
// read alike.
const normalized = (text: string): string => text.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

const PLAN = new Set(["plan", "planmode"]);
const BYPASS = new Set(["bypass", "bypasspermissions", "yolo", "fullaccess", "dangerfullaccess"]);

const matching = (modes: Pick<SessionModes, "available">, names: ReadonlySet<string>): string | undefined =>
    modes.available.find((mode) => names.has(normalized(mode.id)) || names.has(normalized(mode.name)))?.id;

// The agent's own read-only planning mode, where it advertises one.
export const planModeOf = (modes: Pick<SessionModes, "available">): string | undefined => matching(modes, PLAN);

// The agent's own run-without-asking mode, where it advertises one.
export const bypassModeOf = (modes: Pick<SessionModes, "available">): string | undefined => matching(modes, BYPASS);

const homeOf = (state: SessionModeState): string => {
    const special = new Set([planModeOf({ available: state.availableModes }), bypassModeOf({ available: state.availableModes })]);
    if (!special.has(state.currentModeId)) {
        return state.currentModeId;
    }
    return state.availableModes.find((mode) => !special.has(mode.id))?.id ?? state.currentModeId;
};

// What session/new or session/load said about the session's modes. A session the agent states none for keeps none; the
// home of one it already knew is kept, since a loaded session's current mode is whatever its last turn left it in.
export const recordModes = (modes: Map<string, SessionModes>, sessionId: string, state: SessionModeState | null | undefined): void => {
    if (state === null || state === undefined || state.availableModes.length === 0) {
        modes.delete(sessionId);
        return;
    }
    const known = modes.get(sessionId);
    modes.set(sessionId, {
        current: state.currentModeId,
        available: state.availableModes.map((mode) => ({ id: mode.id, name: mode.name })),
        home: known !== undefined && state.availableModes.some((mode) => mode.id === known.home) ? known.home : homeOf(state),
    });
};

// A current_mode_update, or the answer to a set_mode the daemon sent.
export const noteMode = (modes: Map<string, SessionModes>, sessionId: string, currentModeId: string): void => {
    const known = modes.get(sessionId);
    if (known !== undefined) {
        modes.set(sessionId, { ...known, current: currentModeId });
    }
};

// Where one phase of a turn puts the session:
// - a planning phase: the agent's own plan mode, so its read-only posture is the agent's to enforce, not only the
//   preamble's to ask for; the plan card stays the daemon's (plan-mode.ts), since the protocol has no signal that a plan
//   is ready for a yes. Without one, the home mode, so the mutating calls it asks about reach the phase's refusal.
// - bypassPermissions: the agent's bypass mode, only while no rule of the owner's is watching; once the rulebook
//   enforces, a mode that stops the agent asking would stop its calls reaching the rulebook, so the home mode it is.
// - default (approve each call): the home mode, whose asks reach a person.
export const modeFor = (
    modes: SessionModes,
    phase: "plan" | "execute",
    permissionMode: PermissionMode | undefined,
    rulebookEnforcing: boolean,
): string => {
    if (phase === "plan") {
        return planModeOf(modes) ?? modes.home;
    }
    if (permissionMode === "default" || rulebookEnforcing) {
        return modes.home;
    }
    return bypassModeOf(modes) ?? modes.home;
};

// Whether a session left in this mode would run without asking: leaving it is what a person's approvals depend on.
export const isBypassMode = (modes: SessionModes, modeId: string): boolean => bypassModeOf(modes) === modeId;
