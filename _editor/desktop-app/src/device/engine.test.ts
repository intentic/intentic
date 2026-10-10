import "@intentic/testing/dom";
import { freshImport, waitFor } from "@intentic/testing/bun";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { EngineMoveEnd, EngineMoveEvent, EngineStatus } from "../desktop";

// The engine as a window holds it: ic's status read and re-read, a move run at the reader's yes with every step any
// window hears folded in, its end said once whichever of its answer and its last step reaches the window first, the
// reader's "Not now", and the copies a move left removed. The app is Tauri's own IPC mock.

// The kit's device readout (reached through ./runs and ./machine) asks media queries at import; nothing here is about the screen.
Object.defineProperty(window, `matchMedia`, {
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
});

const load = () => freshImport<typeof import("./engine")>("./engine", import.meta.url);

const ON_DOCKER_DESKTOP: EngineStatus = {
    engine: `dockerDesktop`,
    chosen: `dockerDesktop`,
    installed: false,
    running: false,
    version: null,
    active: false,
    held: false,
    distro: `intentic-engine`,
    dockerDesktop: true,
    ownEngine: false,
    preferred: null,
    gpu: false,
    bringYourOwn: false,
    canMove: true,
    offerMove: true,
    moves: null,
};
const ON_OURS: EngineStatus = { ...ON_DOCKER_DESKTOP, engine: `intentic`, active: true, installed: true, running: true, offerMove: false };
const MOVED: EngineMoveEnd = { outcome: `moved`, code: 0, putBack: false, ran: true, engine: `intentic`, count: 1, reason: null, log: `/logs/m.log` };

const step = (name: string, fields: Record<string, unknown> = {}): EngineMoveEvent => ({ step: name, to: `intentic`, ...fields });
const exit = (end: EngineMoveEnd): EngineMoveEvent => ({ step: `exit`, ...end });

let calls: { command: string; args: Record<string, unknown> }[] = [];
let status: EngineStatus | null = ON_DOCKER_DESKTOP;
let yes = true;
let moving: (args: Record<string, unknown>) => EngineMoveEnd | Promise<EngineMoveEnd> = () => MOVED;
let cleaned: () => void = () => undefined;

const asked = (command: string) => calls.filter((call) => call.command === command);

beforeEach(() => {
    calls = [];
    status = ON_DOCKER_DESKTOP;
    yes = true;
    moving = () => MOVED;
    cleaned = () => undefined;
    mockIPC((command, args) => {
        const sent = (args ?? {}) as Record<string, unknown>;
        calls.push({ command, args: sent });
        switch (command) {
            case `engine_status`:
                return status;
            // The system's own dialog, as plugin-dialog asks it: the label of the button pressed.
            case `plugin:dialog|message`: {
                const [ok, cancel] = (sent[`buttons`] as { OkCancelCustom: [string, string] }).OkCancelCustom;
                return yes ? ok : cancel;
            }
            case `engine_move`:
                return moving(sent);
            case `engine_cleanup`:
                cleaned();
                return null;
            default:
                return null;
        }
    });
});
afterEach(() => clearMocks());

it(`reads which engine the sandboxes run on, and follows a move only the status shows until the status says it is over`, async () => {
    const engine = await load();
    status = { ...ON_DOCKER_DESKTOP, moves: { moving: true, to: `intentic`, last: null, leftBehind: [] } };
    await engine.loadEngine();
    expect(engine.engineState.value?.engine).toBe(`dockerDesktop`);
    expect(engine.engineMoving.value).toEqual({ source: `status`, to: `intentic`, moved: 0 });

    status = { ...ON_OURS, moves: { moving: false, to: null, last: { from: `dockerDesktop`, to: `intentic`, at: 5 }, leftBehind: [] } };
    engine.followEngine();
    await waitFor(() => expect(engine.engineMoving.value).toBeUndefined());
    expect(engine.engineState.value?.engine).toBe(`intentic`);
    // Nothing to follow: the status is not asked for again.
    const reads = asked(`engine_status`).length;
    engine.followEngine();
    expect(asked(`engine_status`)).toHaveLength(reads);
});

it(`has nothing to say on a computer whose app has no status for it, and keeps what it knew when ic is silent once`, async () => {
    const engine = await load();
    status = null;
    await engine.loadEngine();
    expect(engine.engineState.value).toBeUndefined();
    expect(engine.engineMoving.value).toBeUndefined();
    status = ON_OURS;
    await engine.loadEngine();
    status = null;
    await engine.loadEngine();
    expect(engine.engineState.value?.engine).toBe(`intentic`);
});

it(`follows a move another window started, step by step, and says how it ended`, async () => {
    const engine = await load();
    await engine.loadEngine();
    engine.hearEngineMove(step(`begin`, { slug: `work`, index: 0, count: 1, bytes: 10 }));
    engine.hearEngineMove(step(`volume`, { slug: `work`, done: 4, total: 10 }));
    expect(engine.engineMoving.value).toMatchObject({ source: `heard`, to: `intentic`, slug: `work`, step: `volume`, done: 4, total: 10 });

    status = ON_OURS;
    const reads = asked(`engine_status`).length;
    engine.hearEngineMove(exit(MOVED));
    expect(engine.engineMoving.value).toBeUndefined();
    expect(engine.engineMoveEnd.value).toEqual(MOVED);
    // The PC switched: read again, so the card names the engine it is on now.
    await waitFor(() => expect(engine.engineState.value?.engine).toBe(`intentic`));
    expect(asked(`engine_status`).length).toBe(reads + 1);
});

it(`keeps following a move from elsewhere when ic refuses another because of it`, async () => {
    const engine = await load();
    status = { ...ON_DOCKER_DESKTOP, moves: { moving: true, to: `intentic`, last: null, leftBehind: [] } };
    await engine.loadEngine();
    engine.hearEngineMove(exit({ ...MOVED, outcome: `busy`, code: 3, putBack: true, engine: null, count: null }));
    expect(engine.engineMoving.value).toMatchObject({ source: `status` });
    expect(engine.engineMoveEnd.value).toBeUndefined();
});

it(`moves at the reader's yes, and says its end once when its last step comes before its answer`, async () => {
    const engine = await load();
    await engine.loadEngine();
    moving = (args) => {
        expect(args).toEqual({ to: `intentic` });
        // While it runs, its steps reach every window, this one included.
        engine.hearEngineMove(step(`begin`, { slug: `work`, index: 0, count: 1 }));
        expect(engine.engineMoving.value).toMatchObject({ source: `ours`, step: `begin` });
        engine.hearEngineMove(step(`moved`, { slug: `work` }));
        engine.hearEngineMove(exit(MOVED));
        expect(engine.engineMoving.value).toBeUndefined();
        return MOVED;
    };
    await engine.moveEngine(`intentic`, true);
    expect(asked(`plugin:dialog|message`)).toHaveLength(1);
    expect(asked(`engine_move`)).toHaveLength(1);
    expect(engine.engineMoving.value).toBeUndefined();
    expect(engine.engineMoveEnd.value).toEqual(MOVED);

    // The next move's steps are heard again: nothing of this one is left waiting for them.
    engine.hearEngineMove(step(`begin`, { slug: `notes`, index: 0, count: 1 }));
    expect(engine.engineMoving.value).toMatchObject({ source: `heard`, slug: `notes` });
});

it(`says its end once when its answer comes first, and its last steps do not bring the move back`, async () => {
    const engine = await load();
    await engine.loadEngine();
    moving = () => {
        engine.hearEngineMove(step(`begin`, { slug: `work`, index: 0, count: 1 }));
        return MOVED;
    };
    await engine.moveEngine(`intentic`, false);
    expect(engine.engineMoving.value).toBeUndefined();
    expect(engine.engineMoveEnd.value).toEqual(MOVED);

    // Steps of the move that just ended, still on their way, then its exit: what the answer already said.
    engine.hearEngineMove(step(`moved`, { slug: `work` }));
    expect(engine.engineMoving.value).toBeUndefined();
    engine.hearEngineMove(exit({ ...MOVED, count: 7 }));
    expect(engine.engineMoveEnd.value).toEqual(MOVED);
    // Past its exit, a move started anywhere else is followed as ever.
    engine.hearEngineMove(step(`begin`, { slug: `notes`, index: 0, count: 1 }));
    expect(engine.engineMoving.value).toMatchObject({ source: `heard`, slug: `notes` });
});

it(`asks first, and a no moves nothing`, async () => {
    const engine = await load();
    yes = false;
    await engine.moveEngine(`docker-desktop`, false);
    expect(asked(`plugin:dialog|message`)).toHaveLength(1);
    expect(asked(`engine_move`)).toHaveLength(0);
    expect(engine.engineMoving.value).toBeUndefined();
});

it(`ends a move that never ran, or that this app refused, on its answer alone`, async () => {
    const engine = await load();
    moving = () => {
        throw new Error(`Intentic's own ic is not beside this app, so this step cannot run.`);
    };
    await engine.moveEngine(`intentic`, false);
    expect(engine.engineMoving.value).toBeUndefined();
    expect(engine.engineMoveError.value).toContain(`not beside this app`);
    expect(engine.engineMoveEnd.value).toBeUndefined();

    const refused: EngineMoveEnd = { outcome: `busy`, code: 3, putBack: true, ran: false, engine: null, count: null, reason: null, log: null };
    moving = () => refused;
    await engine.moveEngine(`intentic`, false);
    expect(engine.engineMoving.value).toBeUndefined();
    expect(engine.engineMoveEnd.value).toEqual(refused);
    expect(engine.engineMoveError.value).toBeUndefined();
    // No exit will come for it: a move another window then starts is followed.
    engine.hearEngineMove(step(`begin`, { slug: `work`, index: 0, count: 1 }));
    expect(engine.engineMoving.value).toMatchObject({ source: `heard` });
});

it(`does not start a second move while one is followed`, async () => {
    const engine = await load();
    engine.hearEngineMove(step(`begin`, { slug: `work`, index: 0, count: 1 }));
    await engine.moveEngine(`intentic`, false);
    expect(asked(`plugin:dialog|message`)).toHaveLength(0);
    expect(asked(`engine_move`)).toHaveLength(0);
});

it(`keeps the reader's "Not now" as a preference for Docker Desktop`, async () => {
    const engine = await load();
    await engine.declineEngineMove();
    expect(asked(`engine_prefer`).map((call) => call.args)).toEqual([{ engine: `docker-desktop` }]);
    expect(asked(`engine_status`).length).toBeGreaterThan(0);
    expect(engine.engineOfferError.value).toBeUndefined();
});

it(`removes the copies at the reader's yes, and says so when an engine kept its own`, async () => {
    const engine = await load();
    const kept = (on: `dockerDesktop` | `intentic`): EngineStatus => ({
        ...ON_OURS,
        moves: { moving: false, to: null, last: null, leftBehind: [{ slug: `work`, on, removeAfter: 1 }] },
    });
    status = kept(`dockerDesktop`);
    await engine.loadEngine();
    cleaned = () => (status = { ...ON_OURS, moves: { moving: false, to: null, last: null, leftBehind: [] } });
    await engine.removeEngineCopies();
    expect(asked(`engine_cleanup`)).toHaveLength(1);
    expect(engine.engineCleaning.value).toBe(false);
    expect(engine.engineCleanupNote.value).toBeUndefined();

    // Docker Desktop was not running: ic leaves its copies for a later round.
    status = kept(`dockerDesktop`);
    cleaned = () => undefined;
    await engine.removeEngineCopies();
    expect(engine.engineCleanupNote.value).toBe(`desktop.engine.copiesStay.dockerDesktop`);

    yes = false;
    await engine.removeEngineCopies();
    expect(asked(`engine_cleanup`)).toHaveLength(2);
});
