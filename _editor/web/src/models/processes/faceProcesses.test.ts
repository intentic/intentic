import type { ProcessReport } from "../../app/environments/processes/processReport";

const opened: string[] = [];
let takesProcesses = true;
jest.mock(`../../app/environments/desktop`, () => ({
    desktopTakesProcesses: () => takesProcesses,
    openDesktopLink: (link: string) => opened.push(link),
}));
jest.mock(`../../app/environments/local`, () => ({ localFace: () => undefined }));
jest.mock(`../../app/environments/localHost`, () => ({ localHost: () => ({}) }));

const report: ProcessReport = { id: `sandbox-setup:sbx_7`, kind: `sandbox-setup`, state: `running`, origin: `app`, subject: `shop` };

const load = async () => import(`./faceProcesses`);

describe(`the workspace's processes`, () => {
    beforeEach(() => {
        opened.length = 0;
        takesProcesses = true;
    });

    it(`says hello once, then hears the app's list`, async () => {
        const { useFaceProcesses } = await load();
        const { list } = useFaceProcesses();
        useFaceProcesses();
        expect(opened.filter((link) => link === `intentic://process?hello=1`)).toHaveLength(1);
        window.dispatchEvent(new CustomEvent(`intentic-processes`, { detail: { processes: [report] } }));
        expect(list.value).toEqual([report]);
    });

    it(`answers the app's runs by link`, async () => {
        const { useFaceProcesses } = await load();
        useFaceProcesses().act(report, `consent`);
        expect(opened).toContain(`intentic://process-act?id=sandbox-setup%3Asbx_7&act=consent`);
    });

    it(`answers a run it holds itself, from its own press and from This computer's`, async () => {
        const { holdProcess, useFaceProcesses } = await load();
        const acts: string[] = [];
        const held = holdProcess(`sandbox-setup:sbx_9`, (act) => acts.push(act));
        const own = { ...report, id: `sandbox-setup:sbx_9`, origin: `workspace` } as const;
        held.tell(own);
        held.tell(own);
        expect(opened.filter((link) => link.startsWith(`intentic://process?report=`))).toHaveLength(1);
        useFaceProcesses().act(own, `retry`);
        window.dispatchEvent(new CustomEvent(`intentic-process-act`, { detail: { id: own.id, act: `dismiss` } }));
        expect(acts).toEqual([`retry`, `dismiss`]);
        held.release();
        expect(opened).toContain(`intentic://process?clear=sandbox-setup%3Asbx_9`);
    });
});
