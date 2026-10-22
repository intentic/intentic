import type { LocalRepairMessage, LocalRepairSession, LocalRepairTool } from "../../app/environments/localHost";
import { doctorReports, engineReport, rawLog, readTool, repairBadgeOf, repairHoldsRail, repairVerdict, toolLook } from "./repairSession";

// Repair's page reads what `ic` printed into rows, and sums the session into one headline and the rail tile's corner.
// Every shape here is one `ic` prints (sandbox/fix/report.rs `result_line`, engine/commands.rs `status_json`).

const result = (slug: string, checks: readonly Record<string, string>[], outcome = `needs-you`): string =>
    JSON.stringify({ slug, report: { source: `app`, machine: `pc`, os: `windows`, stage: `done`, outcome, checks } });

const BROKEN = [
    `intentic-fix: {"slug":"kind-otter","stage":"checking","doing":"Checking"}`,
    result(`kind-otter`, [
        { id: `docker`, label: `Docker engine`, state: `ok` },
        { id: `daemon`, label: `Daemon health`, state: `fail`, problem: `no answer.`, remedy: `ic sandbox restart kind-otter`, fix: `consent` },
        { id: `tunnel`, label: `Public URL`, state: `skip` },
    ]),
].join(`\n`);
const HEALTHY = result(`kind-otter`, [{ id: `docker`, label: `Docker engine`, state: `ok` }], `healthy`);

const tool = (name: string, state: LocalRepairTool[`state`], detail?: string, approvalId?: string): LocalRepairTool => ({
    name,
    state,
    summary: `${name} summary`,
    detail,
    approvalId,
});
const toolMessage = (id: string, row: LocalRepairTool): LocalRepairMessage => ({ id, role: `tool`, text: row.summary, tool: row });
const session = (state: LocalRepairSession[`state`], messages: LocalRepairMessage[]): LocalRepairSession => ({ state, messages });

describe(`doctorReports`, () => {
    it(`reads one report per sandbox out of a transcript, passing over progress lines`, () => {
        const reports = doctorReports(`${BROKEN}\n${result(`brave-heron`, [], `healthy`)}`);
        expect(reports?.map((report) => [report.slug, report.outcome, report.checks.length])).toEqual([
            [`kind-otter`, `needs-you`, 3],
            [`brave-heron`, `healthy`, 0],
        ]);
        expect(reports?.[0]?.checks[1]).toEqual({
            id: `daemon`,
            label: `Daemon health`,
            state: `fail`,
            problem: `no answer.`,
            remedy: `ic sandbox restart kind-otter`,
            fix: `consent`,
        });
    });

    it(`reads an array of results and a bare report alike`, () => {
        expect(doctorReports(`[${HEALTHY}]`)?.[0]?.slug).toBe(`kind-otter`);
        expect(doctorReports(JSON.stringify({ checks: [{ id: `docker`, state: `ok` }] }))?.[0]).toEqual({
            slug: ``,
            outcome: undefined,
            asleep: false,
            checks: [{ id: `docker`, label: `docker`, state: `ok`, problem: undefined, remedy: undefined, fix: undefined }],
        });
    });

    it(`drops a check it cannot read, never the report`, () => {
        const reports = doctorReports(result(`a`, [{ id: `docker`, state: `ok` }, { id: `odd`, state: `exploded` }]));
        expect(reports?.[0]?.checks.map((check) => check.id)).toEqual([`docker`]);
    });

    it(`reads nothing out of text that is no report`, () => {
        expect(doctorReports(`Docker is not running.`)).toBeUndefined();
        expect(doctorReports(`{"engine":"intentic"}`)).toBeUndefined();
    });
});

describe(`engineReport`, () => {
    it(`reads the engine's state`, () => {
        expect(engineReport(JSON.stringify({ engine: `intentic`, installed: true, running: false, held: true, version: `0.9.4`, distro: `x` }))).toEqual({
            engine: `intentic`,
            installed: true,
            running: false,
            held: true,
            version: `0.9.4`,
        });
        expect(engineReport(JSON.stringify({ engine: `dockerDesktop`, version: null }))?.version).toBeUndefined();
        expect(engineReport(`not json`)).toBeUndefined();
    });
});

describe(`readTool and toolLook`, () => {
    it(`reads a doctor's output and wears its worst finding`, () => {
        const done = tool(`doctor`, `done`, BROKEN);
        expect(readTool(done).kind).toBe(`doctor`);
        expect(toolLook(done).tone).toBe(`danger`);
        expect(toolLook(tool(`doctor`, `done`, HEALTHY)).tone).toBe(`success`);
    });

    it(`keeps a short failure as its sentence and a long unreadable output for the raw view`, () => {
        expect(readTool(tool(`engine_status`, `failed`, `Docker is not running.`))).toEqual({ kind: `text`, text: `Docker is not running.` });
        expect(readTool(tool(`sandbox_logs`, `done`, `line\n`.repeat(50))).kind).toBe(`none`);
    });
});

describe(`repairVerdict`, () => {
    it(`asks first, then works, then sums what the last doctor found`, () => {
        const asking = session(`waiting`, [toolMessage(`t`, tool(`fix`, `needsApproval`, undefined, `ok-1`))]);
        expect(repairVerdict(asking).tone).toBe(`warning`);
        expect(repairVerdict(session(`thinking`, [])).busy).toBe(true);
        expect(repairVerdict(session(`idle`, [])).tone).toBe(`neutral`);
        expect(repairVerdict(session(`idle`, [toolMessage(`d`, tool(`doctor`, `done`, BROKEN))])).tone).toBe(`danger`);
        expect(repairVerdict(session(`idle`, [toolMessage(`d`, tool(`doctor`, `done`, HEALTHY))])).tone).toBe(`success`);
    });

    it(`counts a check that could not finish as a problem`, () => {
        expect(repairVerdict(session(`idle`, [toolMessage(`e`, tool(`engine_status`, `failed`, `Docker is not running.`))])).tone).toBe(`danger`);
    });
});

describe(`the rail tile`, () => {
    it(`holds the rail while Repair works or waits, and lets go once it rests`, () => {
        expect(repairBadgeOf(session(`thinking`, []))).toEqual({ running: expect.any(String) });
        expect(repairBadgeOf(session(`idle`, [toolMessage(`r`, tool(`doctor`, `running`))]))).toEqual({ running: expect.any(String) });
        expect(repairBadgeOf(session(`waiting`, [toolMessage(`t`, tool(`fix`, `needsApproval`, undefined, `ok-1`))]))).toMatchObject({ tone: `warning` });
        expect(repairHoldsRail(session(`idle`, [toolMessage(`d`, tool(`doctor`, `done`, BROKEN))]))).toBe(false);
    });
});

describe(`rawLog`, () => {
    it(`writes the session as text, every tool's output as it came`, () => {
        const log = rawLog(
            session(`idle`, [
                { id: `u`, role: `user`, text: `fix it`, tool: undefined },
                toolMessage(`d`, tool(`doctor`, `done`, HEALTHY)),
                { id: `a`, role: `assistant`, text: `Done.`, tool: undefined },
            ]),
        );
        expect(log).toBe(`> fix it\n\n[doctor · done] doctor summary\n${HEALTHY}\n\nDone.`);
    });
});
