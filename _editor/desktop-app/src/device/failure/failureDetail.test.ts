import { failureDetail, failureFacts, stopItems } from "./failureDetail";

// The failures the funnel heard only the headline of (2026-11-21), as ic and the scripts print them whole.

describe(`a failure's problem and fix`, () => {
    it(`are read apart from a stop block that is no list`, () => {
        const block = [
            `ic was downloaded but not installed, and no copy is installed.`,
            `problem: the downloaded ic was removed from C:\\Users\\Ann Smith\\.intentic\\bin\\ic.download.exe as soon as it arrived. Security software on this PC (Norton 360) may be blocking ic.download.exe.`,
            `fix:     ask whoever manages Norton 360 on this PC (at work, your IT) to allow the folder C:\\Users\\Ann Smith\\.intentic\\bin, then run the same command again.`,
        ].join(`\n`);
        expect(failureDetail(block)).toEqual({
            problem: `the downloaded ic was removed from <path> as soon as it arrived. Security software on this PC (Norton 360) may be blocking ic.download.exe.`,
            fix: `ask whoever manages Norton 360 on this PC (at work, your IT) to allow the folder <path> then run the same command again.`,
            blockedBy: `security-software`,
            securityProduct: `Norton 360`,
        });
    });

    it(`carry every item of a list, numbered, with its title`, () => {
        const block = [
            `2 things are in the way:`,
            `1. WSL`,
            `problem: WSL is not installed.`,
            `fix:     run wsl --install as administrator.`,
            `2. Virtualization`,
            `problem: virtualization is off in the firmware.`,
            `fix:     turn it on in the BIOS.`,
        ].join(`\n`);
        expect(failureDetail(block)).toEqual({
            problem: `1. WSL: WSL is not installed. | 2. Virtualization: virtualization is off in the firmware.`,
            fix: `1. run wsl --install as administrator. | 2. turn it on in the BIOS.`,
            problemCount: 2,
        });
        expect(stopItems(`found 1 problem — fix them and re-run the same command:\n1. docker\nproblem: p\nfix: f`)).toEqual([
            { title: `docker`, problem: `p`, fix: `f` },
        ]);
    });

    it(`are scrubbed of the account, a code and any path, and capped`, () => {
        const detail = failureDetail(`x\nproblem: ann@example.com on k7Q2xPz9 at /home/ann/.intentic/a.log for ann\nfix: ${`y`.repeat(400)}`, {
            home: `/home/ann`,
            code: `k7Q2xPz9`,
        });
        expect(detail.problem).toBe(`<email> on <code> at <path> for <user>`);
        expect(detail.fix).toHaveLength(300);
    });

    it(`name security software without a product where Security Center named none`, () => {
        expect(failureDetail(`problem: Windows refused to start it. Security software on this PC may be blocking ic.download.exe.`)).toMatchObject({
            blockedBy: `security-software`,
        });
        expect(failureDetail(`problem: Security software on this PC may be blocking x.`).securityProduct).toBeUndefined();
        expect(failureDetail(`Security software is blocking intentic-machine.exe`).blockedBy).toBe(`security-software`);
    });

    it(`count WSL's out-of-buffers and its failed account lookup by kind`, () => {
        expect(failureDetail(`the engine stopped as it started (exit -1): Kod błędu: Wsl/Service/0x80072747`).cause).toBe(`winsock-buffers`);
        expect(failureDetail(`<3>WSL (12) ERROR: CreateProcessParseCommon:1067: getpwnam(root) failed 5`).cause).toBe(`wsl-user-lookup`);
        expect(failureDetail(`anything else`)).toEqual({});
        expect(failureDetail(undefined)).toEqual({});
    });

    it(`take the failed row, else the error line, as the reason`, () => {
        const said = { line: `error: 1 thing is in the way:`, block: `1 thing is in the way:\n1. WSL\nproblem: p\nfix: f` };
        expect(failureFacts(said, {})).toEqual({ reason: `error: 1 thing is in the way:`, problem: `1. WSL: p`, fix: `1. f`, problemCount: 1 });
        expect(failureFacts({ ...said, row: `the row said so` }, {}).reason).toBe(`the row said so`);
        expect(failureFacts({}, {})).toEqual({});
    });
});
