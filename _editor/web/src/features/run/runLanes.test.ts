import type { DeviceRun, RepoRunTargets } from "@intentic/sandbox-contract/schemas/run-targets";
import { RunTargetsFileSchema } from "@intentic/sandbox-contract/schemas/run-targets";
import { appTargets } from "../../models/preview/previewModel";
import { type DeviceRunList, narrowLanes, type RunDevice, type RunLaneInput, runLanesOf, runningCount } from "./runLanes";
import { SANDBOX } from "./runRows";

// The Run view's lanes: the sandbox and each computer, what runs on each whoever started it, and what could start there.

const declared = (repo: string, targets: unknown[]): RepoRunTargets => ({
    repo,
    path: `${repo}/.intentic/run.json`,
    targets: RunTargetsFileSchema.parse({ targets }).targets,
});

const SHOP = declared(`shop`, [
    { name: `web`, command: `pnpm dev` },
    { name: `desktop`, device: `omen`, artifact: `out/shop.exe` },
    { name: `tool`, artifact: `out/tool.exe` },
]);
const GAME = declared(`game`, [{ name: `server`, device: `rog`, artifact: `target/server.exe` }]);

const ready = (id: string): RunDevice => ({ id, online: true, programs: true, allowed: true });

const run = (over: Partial<DeviceRun> & Pick<DeviceRun, `device` | `id` | `name`>): DeviceRun => ({
    state: `running`,
    said: `running, pid 1`,
    startedAt: `2026-11-07T09:00:00.000Z`,
    ports: [],
    ...over,
});

const input = (over: Partial<RunLaneInput> & { lists?: Record<string, DeviceRunList> } = {}): RunLaneInput => ({
    repos: [
        { repo: `shop`, declared: SHOP, panel: undefined },
        { repo: `game`, declared: GAME, panel: undefined },
    ],
    live: [],
    devices: [ready(`rog`), ready(`omen`)],
    runsOn: (device) => over.lists?.[device],
    inScope: () => true,
    ...over,
});

const keys = (items: readonly { key: string }[]): string[] => items.map((item) => item.key);

test(`the sandbox leads, then every computer by name; a target its file names a computer for waits on that computer's lane`, () => {
    const lanes = runLanesOf(input());
    expect(lanes.map((lane) => lane.place)).toEqual([SANDBOX, `omen`, `rog`]);
    expect(keys(lanes[0]!.idle)).toEqual([`shop/web`]);
    // A target naming no computer waits on every one; each lane can still run any of them through its "Run…".
    expect(keys(lanes[1]!.idle)).toEqual([`shop/desktop`, `shop/tool`]);
    expect(keys(lanes[2]!.idle)).toEqual([`shop/tool`, `game/server`]);
    expect(lanes[2]!.runnable.map(({ row }) => row.name)).toEqual([`desktop`, `tool`, `server`]);
});

test(`what runs on a computer is that lane's, whichever computer its file names, and leaves the idle list`, () => {
    const lanes = runLanesOf(
        input({
            lists: {
                rog: { runs: [run({ device: `rog`, id: `d1`, name: `desktop`, repo: `shop` })], terminals: [] },
                omen: { runs: [], terminals: [{ repo: `shop`, target: `desktop`, session: `job-run-shop-desktop-omen` }] },
            },
        }),
    );
    const rog = lanes.find((lane) => lane.place === `rog`)!;
    const omen = lanes.find((lane) => lane.place === `omen`)!;
    expect(rog.active.map((item) => [item.key, item.state])).toEqual([[`shop/desktop`, `running`]]);
    // Still being built in its terminal on omen: starting, not idle.
    expect(omen.active.map((item) => [item.key, item.state])).toEqual([[`shop/desktop`, `starting`]]);
    expect(keys(omen.idle)).toEqual([`shop/tool`]);
    expect(runningCount(lanes)).toBe(1);
});

test(`a program no run.json names is listed by its own name, and a failure leads its lane`, () => {
    const lanes = runLanesOf(
        input({
            lists: {
                rog: {
                    runs: [
                        run({ device: `rog`, id: `x1`, name: `game-server.exe`, startedBy: `conversation c1` }),
                        run({ device: `rog`, id: `s1`, name: `server`, state: `ended`, said: `exited with code 101`, exitCode: 101 }),
                    ],
                    terminals: [],
                },
            },
        }),
    );
    const rog = lanes.find((lane) => lane.place === `rog`)!;
    expect(rog.active.map((item) => [item.key, item.state, item.repo])).toEqual([
        [`game/server`, `failed`, `game`],
        [`run:x1`, `running`, undefined],
    ]);
    // An ended run that exited cleanly is just something to start again.
    const clean = runLanesOf(
        input({ lists: { rog: { runs: [run({ device: `rog`, id: `s2`, name: `server`, state: `ended`, said: `exited`, exitCode: 0 })], terminals: [] } } }),
    );
    expect(keys(clean.find((lane) => lane.place === `rog`)!.idle)).toContain(`game/server`);
});

test(`a computer that cannot take a run keeps a lane while a target waits for it by name, its block named, after those that can`, () => {
    const asleep = (id: string): RunDevice => ({ id, online: false, programs: true, allowed: true });
    const off = (id: string): RunDevice => ({ ...ready(id), allowed: false });
    const lanes = runLanesOf(input({ devices: [asleep(`rog`), asleep(`z440`), off(`omen`), off(`box`), ready(`zed`)] }));
    expect(lanes.map((lane) => [lane.place, lane.block])).toEqual([
        [SANDBOX, undefined],
        [`zed`, undefined],
        // The shop's desktop names omen and game's server names rog, so both keep a lane; nothing names box or z440.
        [`omen`, `switchOff`],
        [`rog`, `offline`],
    ]);
});

test(`the sandbox's running apps are active; a computer with nothing in scope to run has no lane`, () => {
    const live = appTargets(`shop`, [{ app: `web`, command: `pnpm dev`, running: true, healthy: true, installed: true }]);
    const lanes = runLanesOf(input({ repos: [{ repo: `shop`, declared: declared(`shop`, [{ name: `web`, command: `pnpm dev` }]), panel: undefined }], live }));
    expect(lanes.map((lane) => lane.place)).toEqual([SANDBOX]);
    expect(lanes[0]!.active.map((item) => [item.key, item.state])).toEqual([[`shop/web`, `running`]]);
});

test(`one repository picked: its rows only, its places only; programs of another stay out`, () => {
    const lanes = runLanesOf(
        input({
            lists: {
                rog: { runs: [run({ device: `rog`, id: `g1`, name: `server`, repo: `game` }), run({ device: `rog`, id: `x1`, name: `stray` })], terminals: [] },
            },
        }),
    );
    const game = narrowLanes(lanes, `game`);
    expect(game.map((lane) => lane.place)).toEqual([`omen`, `rog`]);
    expect(keys(game.find((lane) => lane.place === `rog`)!.active)).toEqual([`game/server`]);
    expect(runningCount(lanes, `game`)).toBe(1);
    expect(runningCount(lanes)).toBe(2);
    // The open project's scope applies before: a program no repository is known for is shown only while none narrows.
    const scoped = runLanesOf(input({ inScope: (repo) => repo === `game`, lists: { rog: { runs: [run({ device: `rog`, id: `x1`, name: `stray` })], terminals: [] } } }));
    expect(keys(scoped.find((lane) => lane.place === `rog`)!.active)).toEqual([]);
    expect(scoped.map((lane) => lane.place)).toEqual([`omen`, `rog`]);
});
