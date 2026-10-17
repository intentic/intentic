import "@intentic/testing/dom";
import type { IntenticOsStatus } from "@intentic/sandbox-contract/schemas/intentic-os";
import { freshImport, waitFor } from "@intentic/testing/bun";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { OsRunEnd, OsRunEvent } from "../../desktopOs";
import { registerDesktopCatalog } from "../../i18n";

// This system as a window holds it: ic's status read and re-read, each change run at the reader's yes where it restarts
// this computer or changes its next boot, every change any window starts heard line by line, its end said once whichever
// of its answer and its last event reaches the window first, and a check for updates. The app is Tauri's own IPC mock.

// The kit's device readout (reached through ../runs and ../machine) asks media queries at import; nothing here is about the screen.
Object.defineProperty(window, `matchMedia`, {
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
});

await registerDesktopCatalog();

const load = () => freshImport<typeof import("./system")>("./system", import.meta.url);

const BOOTED: IntenticOsStatus = {
    os: `intentic-os`,
    edition: `desktop`,
    version: `2026.10.13.0`,
    channel: `stable`,
    image: `ghcr.io/intentic/os-desktop:stable`,
    booted: { image: `ghcr.io/intentic/os-desktop:stable`, version: `2026.10.13.0`, digest: `sha256:a`, timestamp: `2026-10-13T09:12:00Z` },
    staged: null,
    rollback: { image: `ghcr.io/intentic/os-desktop:stable`, version: `2026.10.06.0`, digest: `sha256:b`, timestamp: null },
    rollbackQueued: false,
    rebootRequired: false,
    health: { verdict: `green`, failed: [] },
    isolation: `auto`,
    vmRuntime: true,
};
const STAGED: IntenticOsStatus = {
    ...BOOTED,
    staged: { image: `ghcr.io/intentic/os-desktop:stable`, version: `2026.10.20.0`, digest: `sha256:c`, timestamp: null },
    rebootRequired: true,
};

const ended = (fields: Partial<OsRunEnd> = {}): OsRunEnd => ({
    verb: `update`,
    apply: false,
    outcome: `done`,
    code: 0,
    timedOut: false,
    reason: null,
    log: `/logs/os.log`,
    ran: true,
    ...fields,
});
const exit = (end: OsRunEnd): OsRunEvent => ({ kind: `exit`, ...end });

let calls: { command: string; args: Record<string, unknown> }[] = [];
let status: IntenticOsStatus | null | Error = BOOTED;
let yes = true;
let changing: (command: string, args: Record<string, unknown>) => OsRunEnd | Promise<OsRunEnd> = () => ended();

const asked = (command: string) => calls.filter((call) => call.command === command);
const question = () => asked(`plugin:dialog|message`).map((call) => `${String(call.args[`title`])} ${String(call.args[`message`])}`);

beforeEach(() => {
    calls = [];
    status = BOOTED;
    yes = true;
    changing = () => ended();
    mockIPC((command, args) => {
        // SAFETY: every command this store invokes passes a plain object of named arguments, or none.
        const sent = (args ?? {}) as Record<string, unknown>;
        calls.push({ command, args: sent });
        switch (command) {
            case `os_status`:
                if (status instanceof Error) {
                    throw status;
                }
                return status;
            case `os_update_check`:
                return { available: true, version: `2026.10.20.0`, digest: `sha256:c` };
            // The system's own dialog, as plugin-dialog asks it: the label of the button pressed.
            case `plugin:dialog|message`: {
                // SAFETY: `confirm` with an okLabel always sends its two labels as `OkCancelCustom` (plugin-dialog's message).
                const [ok, cancel] = (sent[`buttons`] as { OkCancelCustom: [string, string] }).OkCancelCustom;
                return yes ? ok : cancel;
            }
            case `os_update`:
            case `os_rollback`:
            case `os_reboot`:
            case `os_channel`:
                return changing(command, sent);
            default:
                return null;
        }
    });
});
afterEach(() => clearMocks());

it(`reads what this system is, nothing on a computer that is not Intentic OS, and keeps it through a read that failed`, async () => {
    const system = await load();
    await system.loadOs();
    expect(system.osState.value?.version).toBe(`2026.10.13.0`);

    status = new Error(`ic os status did not answer within 30s`);
    await system.loadOs();
    expect(system.osState.value?.version).toBe(`2026.10.13.0`);

    status = null;
    await system.loadOs();
    expect(system.osState.value).toBeUndefined();
});

it(`reads again on the page's timer only once the status is old, or while the boot's health is still to be judged`, async () => {
    const system = await load();
    // Nothing to follow on a computer that is not Intentic OS.
    status = null;
    await system.loadOs();
    system.followOs(Date.now() + system.OS_REREAD_MS);
    expect(asked(`os_status`)).toHaveLength(1);

    status = BOOTED;
    await system.loadOs();
    system.followOs();
    expect(asked(`os_status`)).toHaveLength(2);
    system.followOs(Date.now() + system.OS_REREAD_MS);
    await waitFor(() => expect(asked(`os_status`)).toHaveLength(3));

    status = { ...BOOTED, health: { verdict: `unknown`, failed: [] } };
    await system.loadOs();
    system.followOs();
    await waitFor(() => expect(asked(`os_status`)).toHaveLength(5));
});

it(`restarts into a staged update only at the reader's yes, saying every sandbox restarts and its turns resume`, async () => {
    const system = await load();
    status = STAGED;
    await system.loadOs();

    yes = false;
    await system.restartOs(`applyUpdate`);
    expect(question()).toHaveLength(1);
    expect(question()[0]).toContain(`Every sandbox on this computer restarts with it, and their running turns resume after.`);
    expect(asked(`os_update`)).toHaveLength(0);
    expect(system.osRun.value).toBeUndefined();

    yes = true;
    changing = () => ended({ apply: true });
    await system.restartOs(`applyUpdate`);
    expect(asked(`os_update`)).toEqual([{ command: `os_update`, args: { apply: true } }]);
    expect(system.osRunEnd.value).toEqual(ended({ apply: true }));
    expect(system.osRun.value).toBeUndefined();
});

it(`restarts into a queued rollback with a plain restart, naming the version it goes back to`, async () => {
    const system = await load();
    status = { ...BOOTED, rollbackQueued: true, rebootRequired: true };
    await system.loadOs();
    changing = () => ended({ verb: `reboot`, apply: true });
    await system.restartOs(`reboot`);
    expect(question()[0]).toContain(`version 2026.10.06.0`);
    expect(asked(`os_reboot`)).toHaveLength(1);
    expect(asked(`os_rollback`)).toHaveLength(0);
});

it(`queues the previous version and switches channel at the reader's yes, and downloads an update without asking`, async () => {
    const system = await load();
    await system.loadOs();

    changing = () => ended({ verb: `rollback` });
    await system.rollBackOs();
    expect(question()[0]).toContain(`Go back to version 2026.10.06.0?`);
    expect(asked(`os_rollback`)).toEqual([{ command: `os_rollback`, args: { apply: false } }]);

    changing = () => ended({ verb: `channel` });
    await system.switchOsChannel(`beta`);
    expect(question()[1]).toContain(`Switch to the beta channel?`);
    expect(asked(`os_channel`)).toEqual([{ command: `os_channel`, args: { channel: `beta` } }]);

    await system.downloadOsUpdate();
    expect(question()).toHaveLength(2);
    expect(asked(`os_update`)).toEqual([{ command: `os_update`, args: { apply: false } }]);
    // Each change is followed by a fresh read of what the next boot runs.
    expect(asked(`os_status`).length).toBeGreaterThanOrEqual(4);
});

it(`follows a change another window started, line by line, to its end`, async () => {
    const system = await load();
    await system.loadOs();
    system.hearOsRun({ kind: `started`, verb: `update`, apply: false, channel: null });
    system.hearOsRun({ kind: `line`, verb: `update`, stream: `stdout`, text: `pulling 2026.10.20.0` });
    expect(system.osRun.value).toEqual({ verb: `update`, apply: false, lines: [`pulling 2026.10.20.0`] });

    // While it runs, this window starts nothing of its own.
    await system.downloadOsUpdate();
    expect(asked(`os_update`)).toHaveLength(0);

    status = STAGED;
    system.hearOsRun(exit(ended()));
    expect(system.osRun.value).toBeUndefined();
    expect(system.osRunEnd.value).toEqual(ended());
    await waitFor(() => expect(system.osState.value?.staged?.version).toBe(`2026.10.20.0`));
});

it(`says its own change's end once, whether its last event or its answer comes first, and no late line brings it back`, async () => {
    const system = await load();
    await system.loadOs();
    let hear: (event: OsRunEvent) => void = () => undefined;
    changing = () => {
        // As the app tells every window, this one included, before it answers.
        hear({ kind: `started`, verb: `update`, apply: false, channel: null });
        hear({ kind: `line`, verb: `update`, stream: `stdout`, text: `staged` });
        return ended();
    };
    hear = system.hearOsRun;
    await system.downloadOsUpdate();
    expect(system.osRun.value).toBeUndefined();
    expect(system.osRunEnd.value).toEqual(ended());

    // Its exit and a last line, arriving after the answer: nothing the answer did not say.
    system.hearOsRun({ kind: `line`, verb: `update`, stream: `stderr`, text: `late` });
    system.hearOsRun(exit(ended()));
    expect(system.osRun.value).toBeUndefined();
    expect(system.osRunEnd.value).toEqual(ended());

    // The next change is heard from its start, as ever.
    system.hearOsRun({ kind: `started`, verb: `update`, apply: false, channel: null });
    system.hearOsRun({ kind: `line`, verb: `update`, stream: `stdout`, text: `again` });
    expect(system.osRun.value?.lines).toEqual([`again`]);
});

it(`leaves another window's change on screen when its own was refused for it, and says a change that never ran`, async () => {
    const system = await load();
    await system.loadOs();
    changing = () => {
        // Another window's change began while this one's was on its way.
        system.hearOsRun({ kind: `started`, verb: `channel`, apply: false, channel: `beta` });
        return ended({ outcome: `busy`, code: null, ran: false, log: null });
    };
    await system.downloadOsUpdate();
    expect(system.osRun.value).toEqual({ verb: `channel`, apply: false, channel: `beta`, lines: [] });
    expect(system.osRunEnd.value?.outcome).toBe(`busy`);
    system.hearOsRun(exit(ended({ verb: `channel` })));
    expect(system.osRun.value).toBeUndefined();

    changing = () => Promise.reject(new Error(`Intentic OS's own ic is not at /usr/bin/ic`));
    await system.downloadOsUpdate();
    expect(system.osRun.value).toBeUndefined();
    expect(system.osRunError.value).toContain(`/usr/bin/ic`);
    system.dismissOsRun();
    expect(system.osRunError.value).toBeUndefined();
});

it(`checks for updates, and says a check that did not finish`, async () => {
    const system = await load();
    await system.checkOsUpdate();
    expect(system.osCheck.value).toEqual({ available: true, version: `2026.10.20.0`, digest: `sha256:c` });
    expect(system.osChecking.value).toBe(false);

    mockIPC(() => {
        throw new Error(`the registry did not answer`);
    });
    await system.checkOsUpdate();
    expect(system.osCheck.value).toBeUndefined();
    expect(system.osCheckError.value).toContain(`the registry did not answer`);
});
