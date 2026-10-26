import {
    desktopProcessActLink,
    desktopProcessClearLink,
    desktopProcessLink,
    processAsks,
    processesOf,
    ProcessListSchema,
    type ProcessReport,
} from "./processReport";

const setup: ProcessReport = {
    id: `sandbox-setup:sbx_7`,
    kind: `sandbox-setup`,
    state: `waiting`,
    origin: `app`,
    subject: `shop`,
    sandboxId: `sbx_7`,
    percent: 40,
    waitingFor: `consent`,
    needs: [{ id: `wsl`, label: `Windows Subsystem for Linux` }],
    actions: [`consent`, `stop`],
};

describe(`a process report crossing from the app`, () => {
    it(`reads back exactly what was sent`, () => {
        expect(ProcessListSchema.parse([setup])).toEqual([setup]);
        expect(ProcessListSchema.parse({ processes: [setup] })).toEqual([setup]);
    });

    it(`keeps the reports it can read and drops the rest, one per id`, () => {
        const later = { ...setup, state: `running`, waitingFor: undefined };
        const list = ProcessListSchema.parse([setup, { id: `nope`, kind: `sandbox-setup`, state: `running` }, { ...setup, kind: `mystery` }, later]);
        expect(list).toHaveLength(1);
        expect(list[0]?.state).toBe(`running`);
        expect(ProcessListSchema.parse(`not a list`)).toEqual([]);
    });

    it(`drops a field out of shape rather than the report`, () => {
        const [read] = ProcessListSchema.parse([{ ...setup, percent: 140, actions: [`consent`, `rm -rf`], needs: [{ id: `x` }, ...(setup.needs ?? [])], step: 7 }]);
        expect(read?.percent).toBe(100);
        expect(read?.actions).toEqual([`consent`]);
        expect(read?.needs).toEqual(setup.needs);
        expect(read?.step).toBeUndefined();
    });

    it(`reads the event's detail, and nothing from another kind of event`, () => {
        expect(processesOf(new CustomEvent(`intentic-processes`, { detail: { processes: [setup] } }))).toEqual([setup]);
        expect(processesOf(new Event(`intentic-processes`))).toBeUndefined();
    });
});

describe(`what a run asks of the reader`, () => {
    it(`asks on a failure, a question and a need, never while it only waits on this PC or the browser`, () => {
        expect(processAsks(setup)).toBe(true);
        expect(processAsks({ ...setup, state: `failed`, needs: [] })).toBe(true);
        expect(processAsks({ ...setup, waitingFor: `pcSetup`, needs: [] })).toBe(false);
        expect(processAsks({ ...setup, kind: `sign-in`, waitingFor: `browser`, needs: [] })).toBe(false);
        expect(processAsks({ ...setup, state: `running`, waitingFor: undefined, needs: [] })).toBe(false);
    });
});

describe(`the workspace's links`, () => {
    it(`tells a run, clears it and answers it`, () => {
        expect(desktopProcessLink(setup)).toMatch(/^intentic:\/\/process\?report=/);
        expect(JSON.parse(new URL(desktopProcessLink(setup)).searchParams.get(`report`) ?? ``)).toEqual(setup);
        expect(desktopProcessClearLink(setup.id)).toBe(`intentic://process?clear=sandbox-setup%3Asbx_7`);
        expect(desktopProcessActLink(setup.id, `allow`, `wsl`)).toBe(`intentic://process-act?id=sandbox-setup%3Asbx_7&act=allow&need=wsl`);
    });
});
