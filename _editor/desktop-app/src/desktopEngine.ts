import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/* WHICH ENGINE THIS PC'S SANDBOXES RUN ON, AND THE MOVE TO THE OTHER (src-tauri/src/engine.rs runs `ic engine`). */

/** An engine as ic names it in what it prints: Docker Desktop, Intentic's own (a dockerd in a WSL distro of ours), or
 *  the Docker of a computer that is not a Windows PC. */
export type EngineId = `dockerDesktop` | `intentic` | `native`;
/** An engine sandboxes can move to, as ic's command line spells it. */
export type MoveTarget = `intentic` | `docker-desktop`;

/** A stopped copy a move left on the engine it left, removed at `removeAfter` (epoch ms) unless removed sooner. */
export interface EngineLeftBehind {
    readonly slug: string;
    readonly on: EngineId;
    readonly removeAfter: number;
}

/** What ic's move journal says (its engine/moves.rs `summary`); null on a PC where nothing ever moved. */
export interface EngineMoves {
    /** A move is running now, from anywhere on this PC (this app, Repair, a terminal). */
    readonly moving: boolean;
    readonly to: EngineId | null;
    readonly last: { readonly from: EngineId; readonly to: EngineId; readonly at: number } | null;
    readonly leftBehind: readonly EngineLeftBehind[];
}

/** `ic engine status --json` (its engine/commands.rs `status_json`), as ic printed it. */
export interface EngineStatus {
    /** What the sandboxes run on now. */
    readonly engine: EngineId;
    /** What a fresh setup here would pick. */
    readonly chosen: EngineId;
    /** Intentic's engine: installed, answering, the one sandboxes run on, stopped on purpose. */
    readonly installed: boolean;
    readonly running: boolean;
    readonly version: string | null;
    readonly active: boolean;
    readonly held: boolean;
    readonly distro: string;
    readonly dockerDesktop: boolean;
    readonly ownEngine: boolean;
    /** The reader's word, as `enginePrefer` saved it. */
    readonly preferred: `intentic` | `dockerDesktop` | null;
    /** A sandbox here was handed the PC's GPU, which only Docker Desktop can give it. */
    readonly gpu: boolean;
    /** The Docker here is the reader's own to keep running: Intentic doesn't install or repair it. */
    readonly bringYourOwn: boolean;
    /** A move is possible: onto Intentic's engine, or back onto an installed Docker Desktop. */
    readonly canMove: boolean;
    /** The move is worth putting in front of the reader, not only keeping in reach. */
    readonly offerMove: boolean;
    /** Absent from an ic before moves. */
    readonly moves?: EngineMoves | null;
}

/** How a move ended (engine.rs `MoveEnd`). */
export interface EngineMoveEnd {
    /** `moved`: the PC runs on the other engine now. `failed`: it stopped. `busy`: another move ran, and this one never started. */
    readonly outcome: `moved` | `failed` | `busy`;
    /** ic's exit code; null when it was killed. */
    readonly code: number | null;
    /** Every sandbox is where it was before: true for every ending ic chose itself, never for one cut short. */
    readonly putBack: boolean;
    /** ic ran, so its steps and its end reached every window; false for one refused because the app was already moving. */
    readonly ran: boolean;
    /** The engine the PC runs on after it. */
    readonly engine: EngineId | null;
    /** How many sandboxes moved. */
    readonly count: number | null;
    /** Why it stopped, in ic's words. */
    readonly reason: string | null;
    readonly log: string | null;
}

/** One step of a move, as every window hears it: an `intentic-move:` line's JSON with the engine it goes `to`, and at the
 *  end `step: "exit"` with the move's EngineMoveEnd. Read field by field (device/engineMove.ts): ic says more than this
 *  names. */
export type EngineMoveEvent = { readonly step: string; readonly slug?: string; readonly to?: EngineId } & Readonly<Record<string, unknown>>;

// Null on a computer that is not a Windows PC, and where ic is missing or did not answer: the card has nothing to say.
export const engineStatus = async (): Promise<EngineStatus | null> => (await invoke<EngineStatus | null>(`engine_status`)) ?? null;
// Minutes long, and every ending is an answer; rejects only when it never ran (no ic beside the app).
export const engineMove = (to: MoveTarget): Promise<EngineMoveEnd> => invoke(`engine_move`, { to });
/** The reader's word on which engine this PC uses from now on; moves nothing. */
export const enginePrefer = (engine: MoveTarget): Promise<void> => invoke(`engine_prefer`, { engine });
/** Remove the copies moves left behind now, rather than once their days are up. */
export const engineCleanup = (): Promise<void> => invoke(`engine_cleanup`);
export const onEngineMove = (handler: (event: EngineMoveEvent) => void): Promise<UnlistenFn> =>
    listen<EngineMoveEvent>(`desktop://engine-move`, (event) => handler(event.payload));
