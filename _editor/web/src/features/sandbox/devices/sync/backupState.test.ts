import { backupState, type DeviceFolderRow } from "@intentic/ui/device";

// The backup row is the one place an absence is shouted, so it must only ever be an absence that means something: a
// project folder is the owner's own and never receives the sandbox's state, which is by design and nothing to fix.

const synced = (overrides: Partial<Pick<DeviceFolderRow, `backupStatus` | `remoteDir` | `paused`>> = {}): DeviceFolderRow => ({
    sandboxId: `sandbox-82789f4106b4`,
    mode: `sync`,
    localDir: `/home/ada/code/my-app`,
    mutagenStatus: `watching`,
    ...overrides,
});

describe(`backupState`, () => {
    it(`shouts a workspace folder whose backup is not running`, () => {
        expect(backupState(synced())).toBe(`not backed up`);
        expect(backupState(synced({ remoteDir: `/work` }))).toBe(`not backed up`);
        expect(backupState(synced({ backupStatus: `watching` }))).toBe(`watching`);
    });

    it(`says nothing about a project folder, which carries no backup by design`, () => {
        expect(backupState(synced({ remoteDir: `/work/my-app` }))).toBeUndefined();
    });
});
