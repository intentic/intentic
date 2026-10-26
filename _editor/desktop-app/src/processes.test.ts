import "@intentic/testing/dom";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { answering, clearProcess, kindOf, processOf, reportProcess } from "./processes";

// The app's one process list as this bundle takes part in it (2026-10-26): a run is reported when it is news, cleared
// once, and its answers reach whoever drives it.

let calls: { command: string; args: unknown }[] = [];
afterEach(() => {
    clearMocks();
    calls = [];
});
const listen = (): void =>
    mockIPC((command, args) => {
        calls.push({ command, args });
        return null;
    });

describe(`a run this window drives`, () => {
    it(`is sent when it is news, and not again for the same words`, async () => {
        listen();
        const running = { ...processOf(`recreate`, `shop`, `running`), subject: `shop` };
        reportProcess(running);
        reportProcess({ ...running, at: 5 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls.filter((call) => call.command === `process_report`)).toHaveLength(1);
        reportProcess({ ...running, state: `done` });
        clearProcess(running.id);
        clearProcess(running.id);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls.map((call) => call.command)).toEqual([`process_report`, `process_report`, `process_clear`]);
    });

    it(`is answered by whoever drives its kind`, () => {
        answering(`docker`, () => undefined);
        expect(kindOf(`docker:engine`)).toBe(`docker`);
        expect(kindOf(`mystery:x`)).toBeUndefined();
    });
});
