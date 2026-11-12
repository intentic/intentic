// A process's page, the same in both faces: what it is and how far, what it asks, why it stopped, and every press it
// takes, answered here. The run is never the page's, so a page whose run is gone says so rather than drawing a blank.
import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h } from "vue";
import type { ProcessAction, ProcessReport } from "../../app/environments/processes/processReport";

const { default: ProcessPage } = await import("./ProcessPage.vue");
const { default: ProcessTiles } = await import("./ProcessTiles.vue");
const { processTileOf } = await import("../../models/processes/processTiles");

let app: App | undefined;
const acts: [ProcessAction, string | undefined][] = [];

const mountPage = (report: ProcessReport | undefined): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(ProcessPage, { report, onAct: (act: ProcessAction, need?: string) => acts.push([act, need]) }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    acts.length = 0;
    document.body.innerHTML = ``;
});

const waiting: ProcessReport = {
    id: `pc-setup:this`,
    kind: `pc-setup`,
    state: `waiting`,
    origin: `app`,
    waitingFor: `consent`,
    needs: [
        { id: `wsl`, label: `Windows Subsystem for Linux`, detail: `Runs Linux on Windows` },
        { id: `drive`, label: `Allow the D: drive`, actions: [`allow`, `deny`] },
    ],
    actions: [`consent`, `use-hosted`, `stop`],
};

it(`says what the run waits for, what it asks, and takes every answer here`, () => {
    const el = mountPage(waiting);
    expect(el.querySelector(`h1`)?.textContent).toContain(`Preparing this computer`);
    expect(el.querySelector(`[data-process-note]`)?.textContent).toContain(`Waiting for your go-ahead`);
    expect(el.querySelector(`[data-process-needs]`)?.textContent).toContain(`Windows Subsystem for Linux`);
    const press = (label: string): void => [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label)?.click();
    press(`Allow`);
    press(`Go ahead`);
    press(`Use a machine of ours instead`);
    expect(acts).toEqual([
        [`allow`, `drive`],
        [`consent`, undefined],
        [`use-hosted`, undefined],
    ]);
});

it(`says why a failed run stopped`, () => {
    const el = mountPage({ ...waiting, state: `failed`, waitingFor: undefined, needs: [], failure: `Docker did not start.`, actions: [`retry`, `dismiss`] });
    expect(el.querySelector(`[data-process-failure]`)?.textContent).toContain(`Docker did not start.`);
});

it(`says a run that has gone is over, rather than drawing nothing`, () => {
    const el = mountPage(undefined);
    expect(el.textContent).toContain(`This has ended.`);
});

it(`draws no group, divider included, while nothing runs, and a tile per run otherwise`, () => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const opened: string[] = [];
    app = createApp({
        render: () => h(ProcessTiles, { tiles: [processTileOf(waiting)], selected: undefined, onOpen: (tile: { id: string }) => opened.push(tile.id) }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    const tile = el.querySelector<HTMLButtonElement>(`[data-process-tile="pc-setup"]`);
    expect(tile?.getAttribute(`aria-label`)).toBe(`Preparing this computer · Waiting for your go-ahead`);
    tile?.click();
    expect(opened).toEqual([`pc-setup:this`]);
    app.unmount();
    app = createApp({ render: () => h(ProcessTiles, { tiles: [] }) });
    app.mount(el);
    expect(el.querySelector(`[data-process-tiles]`)).toBeNull();
    expect(el.querySelector(`.icon-rail-divider`)).toBeNull();
});

it(`copies a need's note itself, never sending the press to the run, and says it landed`, async () => {
    const written: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, `clipboard`);
    Object.defineProperty(navigator, `clipboard`, { configurable: true, value: { writeText: (text: string) => Promise.resolve(void written.push(text)) } });
    try {
        const note = `Please allow Intentic on this PC.\nFile: intentic-machine 1.410.1`;
        const el = mountPage({
            id: `agent-install:this`,
            kind: `agent-install`,
            state: `failed`,
            origin: `app`,
            failure: `Windows refused to save intentic-machine.exe.`,
            needs: [{ id: `security-software`, label: `Bitdefender Endpoint Security Tools is blocking intentic-machine.exe`, detail: note, actions: [`copy`] }],
            actions: [`retry`, `dismiss`],
        });
        expect(el.querySelector(`h1`)?.textContent).toContain(`Intentic's agent on this computer`);
        expect(el.querySelector(`[data-process-need-detail]`)?.textContent).toBe(note);
        const button = (label: string): HTMLButtonElement | undefined => [...el.querySelectorAll(`button`)].find((each) => each.textContent?.trim() === label);
        button(`Copy the note`)?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(written).toEqual([note]);
        expect(acts).toEqual([]);
        expect(button(`Copied`)?.textContent?.trim()).toBe(`Copied`);
        button(`Try again`)?.click();
        expect(acts).toEqual([[`retry`, undefined]]);
    } finally {
        if (clipboard === undefined) {
            Reflect.deleteProperty(navigator, `clipboard`);
        } else {
            Object.defineProperty(navigator, `clipboard`, clipboard);
        }
    }
});
