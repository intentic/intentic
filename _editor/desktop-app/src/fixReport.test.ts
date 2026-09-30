import {
    consentChecks,
    endFix,
    EXIT_CONSENT,
    EXIT_RESTART,
    type FixView,
    foldFixLine,
    isCheckId,
    parseFixLine,
    SAID_KEPT,
    startFix,
    troubled,
    verdictOf,
} from "./fixReport";

// Lines as `ic sandbox fix <slug> --json` writes them on stdout: progress while it works, one final line per sandbox.
// The progress shape is not pinned yet, so both spellings the app accepts are here: wrapped in `{ slug, report }`,
// and the report's own fields at the top.
const SLUG = `sandbox-3f2a9c1d7e4b`;

const RUN = [
    `intentic-fix: {"slug":"${SLUG}","report":{"stage":"checking","checks":[{"id":"docker-app","label":"Docker Desktop","state":"fail","problem":"Docker Desktop is not running.","remedy":"We will start it.","fix":"auto"},{"id":"disk","label":"Disk space","state":"ok"}]}}`,
    `intentic-fix: {"stage":"fixing","doing":"Starting Docker Desktop","checks":[{"id":"docker-app","state":"fixing"}]}`,
    `intentic-fix: {"checks":[{"id":"docker-app","label":"Docker Desktop","state":"ok"},{"id":"container","label":"Sandbox container","state":"warn","problem":"The container is stopped.","remedy":"Say yes and ic starts it.","fix":"consent"}]}`,
    `{"slug":"${SLUG}","report":{"source":"app","machine":"rog","os":"windows","stage":"done","outcome":"needs-you","checks":[{"id":"docker-app","label":"Docker Desktop","state":"ok"},{"id":"disk","label":"Disk space","state":"ok"},{"id":"container","label":"Sandbox container","state":"warn","problem":"The container is stopped.","remedy":"Say yes and ic starts it.","fix":"consent"}]}}`,
];

const fold = (lines: readonly string[], view: FixView = startFix(SLUG)): FixView =>
    lines.reduce((held, line) => foldFixLine(held, `stdout`, line), view);

describe(`reading one line of ic's stdout`, () => {
    it(`reads a progress line wrapped in its slug`, () => {
        expect(parseFixLine(RUN[0] ?? ``)).toEqual({
            kind: `progress`,
            slug: SLUG,
            report: {
                stage: `checking`,
                checks: [
                    {
                        id: `docker-app`,
                        label: `Docker Desktop`,
                        state: `fail`,
                        problem: `Docker Desktop is not running.`,
                        remedy: `We will start it.`,
                        fix: `auto`,
                    },
                    { id: `disk`, label: `Disk space`, state: `ok` },
                ],
            },
        });
    });

    it(`reads a progress line whose report is the line itself`, () => {
        expect(parseFixLine(RUN[1] ?? ``)).toEqual({
            kind: `progress`,
            report: { stage: `fixing`, doing: `Starting Docker Desktop`, checks: [{ id: `docker-app`, state: `fixing` }] },
        });
    });

    it(`reads a flat progress line with its slug beside the stage, and a machine's whose slug is null`, () => {
        expect(parseFixLine(`intentic-fix: {"slug":"${SLUG}","stage":"fixing","doing":"Starting Docker Desktop"}`)).toEqual({
            kind: `progress`,
            slug: SLUG,
            report: { stage: `fixing`, doing: `Starting Docker Desktop` },
        });
        expect(parseFixLine(`intentic-fix: {"slug":null,"stage":"checking","doing":null}`)).toEqual({ kind: `progress`, report: { stage: `checking` } });
        // The machine's own line is about every sandbox on it, this one included.
        expect(fold([`intentic-fix: {"slug":null,"stage":"checking","doing":null}`]).stage).toBe(`checking`);
    });

    it(`reads the final line, whatever else rides in its report`, () => {
        const line = parseFixLine(RUN[3] ?? ``);
        expect(line?.kind).toBe(`final`);
        expect(line?.slug).toBe(SLUG);
        expect(line?.report.outcome).toBe(`needs-you`);
        expect(line?.report.checks?.map((check) => check.id)).toEqual([`docker-app`, `disk`, `container`]);
    });

    it(`keeps a state, a fix, an outcome or a stage it has never heard of as the word it is`, () => {
        expect(
            parseFixLine(`intentic-fix: {"stage":"rebooting","outcome":"partly","checks":[{"id":"gpu","label":"GPU","state":"degraded","fix":"vendor"}]}`),
        ).toEqual({
            kind: `progress`,
            report: { stage: `rebooting`, outcome: `partly`, checks: [{ id: `gpu`, label: `GPU`, state: `degraded`, fix: `vendor` }] },
        });
    });

    it(`drops a check it cannot key, and a field that is not a string`, () => {
        expect(parseFixLine(`intentic-fix: {"checks":[{"label":"No id","state":"ok"},{"id":"","state":"ok"},{"id":"wsl","state":3,"label":null}]}`)).toEqual({
            kind: `progress`,
            report: { checks: [{ id: `wsl` }] },
        });
    });

    it(`passes over everything that is not part of the report`, () => {
        for (const line of [
            ``,
            `Checking this device...`,
            `intentic: [checking-docker] checking this PC for Docker...`,
            `intentic-requirement: {"id":"docker-desktop","action":"fix"}`,
            // Cut short when the pipe closed mid-write.
            `intentic-fix: {"stage":"fix`,
            `intentic-fix: ["checking"]`,
            `intentic-fix: "checking"`,
            `intentic-fix: null`,
            // A JSON object that is not a final line: it carries no report.
            `{"slug":"${SLUG}"}`,
            `{"slug":"${SLUG}","report":"done"}`,
            `[{"slug":"work"}]`,
        ]) {
            expect(parseFixLine(line)).toBeUndefined();
        }
    });

    it(`reads a line with the carriage return and indentation a Windows pipe may leave on it`, () => {
        expect(parseFixLine(`  intentic-fix: {"stage":"checking"}\r`)).toEqual({ kind: `progress`, report: { stage: `checking` } });
    });
});

describe(`folding a run into the view`, () => {
    it(`says what it is doing now, and the stage's own word once a line names only the stage`, () => {
        const fixing = fold(RUN.slice(0, 2));
        expect([fixing.stage, fixing.doing]).toEqual([`fixing`, `Starting Docker Desktop`]);
        // A line with checks and no stage leaves what it is doing alone.
        expect(fold(RUN.slice(0, 3)).doing).toBe(`Starting Docker Desktop`);
        // A new stage with no `doing` is a moment with nothing more specific to say.
        const asking = fold([...RUN.slice(0, 3), `intentic-fix: {"stage":"asking"}`]);
        expect([asking.stage, asking.doing]).toEqual([`asking`, undefined]);
    });

    it(`keeps the latest word on each check, on the row it first appeared on`, () => {
        const view = fold(RUN.slice(0, 3));
        expect(view.checks).toEqual([
            { id: `docker-app`, label: `Docker Desktop`, state: `ok` },
            { id: `disk`, label: `Disk space`, state: `ok` },
            {
                id: `container`,
                label: `Sandbox container`,
                state: `warn`,
                problem: `The container is stopped.`,
                remedy: `Say yes and ic starts it.`,
                fix: `consent`,
            },
        ]);
        // A line that names a check by id alone keeps the label and the state it had.
        expect(fold([...RUN.slice(0, 1), `intentic-fix: {"checks":[{"id":"disk"}]}`]).checks[1]).toEqual({ id: `disk`, label: `Disk space`, state: `ok` });
        // A check first named by id alone is labelled by its id, with no state until one is said.
        expect(fold([`intentic-fix: {"checks":[{"id":"tunnel"}]}`]).checks).toEqual([{ id: `tunnel`, label: `tunnel`, state: `` }]);
    });

    it(`takes the final report as the whole of it`, () => {
        const view = fold(RUN);
        expect(view.final).toBe(true);
        expect(view.reported).toBe(true);
        expect([view.stage, view.outcome]).toEqual([`done`, `needs-you`]);
        expect(view.checks.map((check) => `${check.id}:${check.state}`)).toEqual([`docker-app:ok`, `disk:ok`, `container:warn`]);
        // A check the progress named and the final report does not is not the machine's any more.
        const final = fold([`intentic-fix: {"checks":[{"id":"gone","state":"fail"}]}`, RUN[3] ?? ``]);
        expect(final.checks.map((check) => check.id)).toEqual([`docker-app`, `disk`, `container`]);
    });

    it(`ignores a line about another sandbox`, () => {
        const other = `{"slug":"work","report":{"stage":"done","outcome":"healthy","checks":[]}}`;
        expect(fold([other])).toEqual(startFix(SLUG));
        expect(fold([`intentic-fix: {"slug":"work","report":{"stage":"fixing"}}`])).toEqual(startFix(SLUG));
    });

    it(`keeps ic's last few words on stderr, and nothing of them as the report`, () => {
        const said = Array.from({ length: SAID_KEPT + 2 }, (_, index) => `line ${index}`);
        const view = said.reduce((held, line) => foldFixLine(held, `stderr`, line), foldFixLine(startFix(SLUG), `stderr`, `   `));
        expect(view.said).toEqual(said.slice(2));
        expect(view.reported).toBe(false);
        // A report line on stderr is words for a person, not the report.
        expect(foldFixLine(startFix(SLUG), `stderr`, RUN[0] ?? ``).checks).toEqual([]);
    });
});

describe(`the verdict`, () => {
    it(`is running until the command answers`, () => {
        expect(verdictOf(fold(RUN))).toEqual({ kind: `running` });
    });

    it(`says an ic with no report to give cannot fix yet, whatever its exit code`, () => {
        const old = foldFixLine(startFix(SLUG), `stderr`, `error: unrecognized subcommand 'fix'`);
        expect(verdictOf(endFix(old, { code: 2, timedOut: false }))).toEqual({ kind: `unsupported` });
        expect(verdictOf(endFix(startFix(SLUG), { code: 1, timedOut: false }))).toEqual({ kind: `unsupported` });
        expect(verdictOf(endFix(startFix(SLUG), { code: 0, timedOut: false }))).toEqual({ kind: `unsupported` });
    });

    it(`says a run stopped at the app's limit was stopped, report or not`, () => {
        expect(verdictOf(endFix(fold(RUN.slice(0, 2)), { code: null, timedOut: true }))).toEqual({ kind: `stopped` });
    });

    it(`carries the report's outcome and what the exit code says is left`, () => {
        expect(verdictOf(endFix(fold(RUN), { code: 1, timedOut: false }))).toEqual({ kind: `ended`, outcome: `needs-you`, code: 1 });
        expect(verdictOf(endFix(fold(RUN), { code: EXIT_CONSENT, timedOut: false }))).toEqual({
            kind: `ended`,
            outcome: `needs-you`,
            code: 3,
            next: `consent`,
        });
        expect(verdictOf(endFix(fold(RUN), { code: EXIT_RESTART, timedOut: false }))).toEqual({
            kind: `ended`,
            outcome: `needs-you`,
            code: 4,
            next: `restart`,
        });
        const healthy = fold([`{"slug":"${SLUG}","report":{"stage":"done","outcome":"healthy","checks":[{"id":"disk","label":"Disk space","state":"ok"}]}}`]);
        expect(verdictOf(endFix(healthy, { code: 0, timedOut: false }))).toEqual({ kind: `ended`, outcome: `healthy`, code: 0 });
        // Progress with no final line still ran: the exit code is the verdict.
        expect(verdictOf(endFix(fold(RUN.slice(0, 2)), { code: 0, timedOut: false }))).toEqual({ kind: `ended`, code: 0 });
    });

    it(`keeps the two exit codes ic gives them`, () => {
        expect([EXIT_CONSENT, EXIT_RESTART]).toEqual([3, 4]);
    });
});

describe(`the consent buttons`, () => {
    it(`offers one per check ic can close once the user says yes, and only once the run has ended`, () => {
        expect(consentChecks(fold(RUN))).toEqual([]);
        expect(consentChecks(endFix(fold(RUN), { code: EXIT_CONSENT, timedOut: false })).map((check) => [check.id, check.label])).toEqual([
            [`container`, `Sandbox container`],
        ]);
    });

    it(`never offers a check whose id could reach the command line as anything but a check`, () => {
        const risky = fold([
            `{"slug":"${SLUG}","report":{"stage":"done","outcome":"needs-you","checks":[{"id":"--yes","label":"A","fix":"consent"},{"id":"a,b","label":"B","fix":"consent"},{"id":"wsl","label":"WSL","fix":"consent"},{"id":"disk","label":"Disk","fix":"you"}]}}`,
        ]);
        expect(consentChecks(endFix(risky, { code: 1, timedOut: false })).map((check) => check.id)).toEqual([`wsl`]);
    });

    it(`holds a check id to a plain token of at most 64 characters`, () => {
        expect(isCheckId(`docker-app`)).toBe(true);
        expect(isCheckId(`wsl.features_2`)).toBe(true);
        expect(isCheckId(`x`.repeat(64))).toBe(true);
        expect(isCheckId(`x`.repeat(65))).toBe(false);
        for (const id of [``, `-x`, `--accept`, `.hidden`, `_x`, `a b`, `a,b`, `a/b`, `a\nb`]) {
            expect(isCheckId(id)).toBe(false);
        }
    });
});

describe(`what a check shows under its label`, () => {
    it(`shows the problem and the remedy only where something is wrong`, () => {
        const view = fold(RUN.slice(0, 1));
        expect(view.checks.map(troubled)).toEqual([true, false]);
        expect(troubled({ id: `x`, label: `X`, state: `fixing`, problem: `p` })).toBe(false);
        expect(troubled({ id: `x`, label: `X`, state: `warn` })).toBe(true);
    });
});
