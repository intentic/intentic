import { describe, expect, it } from "bun:test";
import type { TerminalTab } from "../useTerminal";
import { hasWork, killAsks, killQuestion } from "./killPlan";

// Pins when a kill asks first and what it names: one idle session goes on the press, a busy one or a bulk kill of live
// ones asks, the question names the command (cut at 24 characters) or counts, and lists busy sessions over live ones.

const shell = (name: string, over: Partial<TerminalTab> = {}): TerminalTab => ({ name, kind: `shell`, running: true, activityAt: 0, ...over });
const idle = shell(`idle`);
const build = shell(`build`, { command: `pnpm run build --filter @intentic/web-and-more` });
const tests = shell(`tests`, { command: `bun test` });
const done = shell(`done`, { running: false });
const logs = shell(`logs`, { kind: `process`, command: `tail -f` });
const order = [idle, build, tests, done, logs];

describe(`whether a kill asks`, () => {
    it.each<[string, string[], boolean]>([
        [`one idle session`, [`idle`], false],
        [`one busy session`, [`build`], true],
        [`finished sessions in bulk`, [`done`, `done`], false],
        [`live sessions in bulk`, [`idle`, `done`], true],
        [`a process log view, whatever it runs`, [`logs`], false],
    ])(`%s`, (_, names, asks) => {
        expect(killAsks(order, names)).toBe(asks);
    });

    it(`calls busy only a session with a command that is not a process view`, () => {
        expect([idle, build, logs, undefined].map(hasWork)).toEqual([false, true, false, false]);
    });
});

describe(`the question a kill asks`, () => {
    it(`names the one busy command, cut short`, () => {
        expect(killQuestion(order, [`build`, `idle`])).toEqual({
            header: `Kill the terminal running pnpm run build --filter ?`,
            body: `This stops what it is doing. Scrollback goes with it, and there is no undo.`,
            items: [build],
        });
    });

    it(`counts busy sessions, listing only those`, () => {
        expect(killQuestion(order, [`build`, `tests`, `idle`])).toEqual({
            header: `Kill 2 busy terminals?`,
            body: `This stops what they are doing. Scrollback goes with it, and there is no undo.`,
            items: [build, tests],
        });
    });

    it(`counts the live sessions a kill ends when none is busy`, () => {
        expect(killQuestion(order, [`idle`, `done`])).toEqual({
            header: `Kill the running terminal?`,
            body: `Killing these ends whatever they are running. Scrollback goes with them.`,
            items: [idle],
        });
        expect(killQuestion([shell(`a`), shell(`b`)], [`a`, `b`]).header).toBe(`Kill 2 running terminals?`);
    });
});
