import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { OsDriveImportEnd, OsDrivesSeen } from "../../osSettings";
import { registerDesktopCatalog } from "../../i18n";
import { example, GOLDEN } from "./golden.testing";

// The drives as a window holds them: the list from the app's watcher, a copy into a sandbox followed to its end whichever
// window started it, an eject, the drives the reader has seen, and the words of the app's notification for a new drive
// handed over in the reader's language. The app is Tauri's own IPC mock, and ic's answers are the contract's examples.

await registerDesktopCatalog();

const load = () => freshImport<typeof import("./drives")>("./drives", import.meta.url);

const SEEN: OsDrivesSeen = { drives: example(GOLDEN.drives).drives, fresh: [`/dev/sda1`] };

const END: OsDriveImportEnd = {
    device: `/dev/sda1`,
    sandbox: `work`,
    outcome: `done`,
    copied: example(GOLDEN.driveImport),
    code: 0,
    timedOut: false,
    reason: null,
    log: `/logs/import.log`,
    ran: true,
};

let calls: { command: string; args: Record<string, unknown> }[] = [];
let importing: () => OsDriveImportEnd | Promise<OsDriveImportEnd> = () => END;
/** The commands that fail, with their words. */
let failing = new Map<string, string>();

const asked = (command: string) => calls.filter((call) => call.command === command);

const answer = (command: string): object | null => {
    switch (command) {
        case `os_drives_list`:
            return SEEN;
        default:
            return null;
    }
};

beforeEach(() => {
    calls = [];
    importing = () => END;
    failing = new Map();
    mockIPC((command, args) => {
        // SAFETY: every command this store invokes passes a plain object of named arguments, or none.
        const sent = (args ?? {}) as Record<string, unknown>;
        calls.push({ command, args: sent });
        const failure = failing.get(command);
        if (failure !== undefined) {
            throw new Error(failure);
        }
        return command === `os_drive_import` ? importing() : answer(command);
    });
});
afterEach(() => clearMocks());

it(`starts once a window: follows the drives and every copy, reads the list, and hands the app its words`, async () => {
    const drives = await load();
    await drives.startDrives();
    await drives.startDrives();
    expect(asked(`os_drives_list`)).toHaveLength(1);
    expect(drives.drives.value).toEqual(SEEN);
    expect(asked(`plugin:event|listen`).map((call) => call.args[`event`])).toEqual([`desktop://os-drives`, `desktop://os-drive-import`]);
    expect(asked(`os_drive_words`)[0]?.args).toEqual({
        words: {
            usbNamed: `USB drive {name} plugged in`,
            usb: `USB drive plugged in`,
            cardNamed: `Memory card {name} put in`,
            card: `Memory card put in`,
            otherNamed: `Drive {name} plugged in`,
            other: `Drive plugged in`,
            body: `Choose where it goes`,
        },
    });
});

it(`copies a drive into a sandbox, into a folder when one is named, and says how it ended`, async () => {
    const drives = await load();
    await drives.copyDrive(`/dev/sda1`, `work`);
    expect(asked(`os_drive_import`)[0]?.args).toEqual({ device: `/dev/sda1`, sandbox: `work`, path: null });
    expect(drives.copying.value).toBeUndefined();
    expect(drives.copyEnd.value).toEqual(END);

    await drives.copyDrive(`/dev/sdb1`, `photos`, `Photos/2026`);
    expect(asked(`os_drive_import`)[1]?.args).toEqual({ device: `/dev/sdb1`, sandbox: `photos`, path: `Photos/2026` });

    importing = () => ({ ...END, outcome: `noRoom`, copied: null, code: 6, reason: `it needs 12.4 GB and the sandbox has 3.1 GB free` });
    await drives.copyDrive(`/dev/sdb1`, `work`);
    expect(drives.copyEnd.value?.outcome).toBe(`noRoom`);
    expect(drives.copyEnd.value?.reason).toContain(`3.1 GB free`);
    drives.dismissCopy();
    expect(drives.copyEnd.value).toBeUndefined();

    failing.set(`os_drive_import`, `Intentic OS's own ic is not at /usr/bin/ic`);
    await drives.copyDrive(`/dev/sda1`, `work`);
    expect(drives.copyError.value).toContain(`/usr/bin/ic`);
    expect(drives.copying.value).toBeUndefined();
});

it(`follows a copy another window started, and starts none of its own meanwhile`, async () => {
    const drives = await load();
    drives.hearCopy({ kind: `started`, device: `/dev/sdb1`, sandbox: `photos` });
    drives.hearCopy({ kind: `progress`, device: `/dev/sdb1`, sandbox: `photos`, bytes: 10, total: 40 });
    expect(drives.copying.value).toEqual({ device: `/dev/sdb1`, sandbox: `photos`, bytes: 10, total: 40 });

    await drives.copyDrive(`/dev/sda1`, `work`);
    expect(asked(`os_drive_import`)).toHaveLength(0);

    drives.hearCopy({ kind: `exit`, ...END, device: `/dev/sdb1`, sandbox: `photos` });
    expect(drives.copying.value).toBeUndefined();
    expect(drives.copyEnd.value?.sandbox).toBe(`photos`);
    // The next copy is heard from its start.
    drives.hearCopy({ kind: `started`, device: `/dev/sda1`, sandbox: `work` });
    expect(drives.copyEnd.value).toBeUndefined();
});

it(`stops a copy by its run`, async () => {
    const drives = await load();
    await drives.stopCopy();
    expect(asked(`run_stop`)[0]?.args).toEqual({ id: `os-drive-import` });
});

it(`ejects a drive and says it can be pulled out, or why not until the drive leaves`, async () => {
    const drives = await load();
    await drives.ejectDrive(`/dev/sda1`, `KINGSTON`);
    expect(asked(`os_drive_eject`)[0]?.args).toEqual({ device: `/dev/sda1` });
    expect(drives.ejected.value).toBe(`KINGSTON`);
    expect(drives.ejecting.value).toBeUndefined();

    failing.set(`os_drive_eject`, `target is busy`);
    await drives.ejectDrive(`/dev/sdb1`, `Photos`);
    expect(drives.ejected.value).toBeUndefined();
    expect(drives.ejectError.value).toEqual({ device: `/dev/sdb1`, name: `Photos`, reason: `Error: target is busy` });
    drives.hearDrives(SEEN);
    expect(drives.ejectError.value?.device).toBe(`/dev/sdb1`);
    drives.hearDrives({ drives: SEEN.drives.filter((drive) => drive.device !== `/dev/sdb1`), fresh: [] });
    expect(drives.ejectError.value).toBeUndefined();
});

it(`tells the app which new drives the reader has seen, and nothing when there are none`, async () => {
    const drives = await load();
    await drives.markSeen([]);
    expect(asked(`os_drives_seen`)).toHaveLength(0);
    await drives.markSeen([`/dev/sda1`]);
    expect(asked(`os_drives_seen`)[0]?.args).toEqual({ devices: [`/dev/sda1`] });
});
