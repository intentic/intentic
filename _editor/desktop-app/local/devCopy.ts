import { sleep as pause } from "@intentic/base/async";
import type { FolderSetup, FolderStanding } from "../src/desktop";

// A FOLDER'S FIRST COPY, STOOD IN FOR (devDesktop.ts), as the machine agent counts it off Mutagen (its sync/report.ts `copyOf`):
// connecting, a scan, files crossing a few at a time, then put in place. The folder is the one the stand-in's preview
// counts (devDesktop.ts `project_preview`): 128 files, 3.1 MB.

type Change = (path: string, next: Partial<FolderSetup> & FolderStanding) => Promise<void>;

const COPY = { files: 128, bytes: 3_276_800 } as const;
const BATCH = 8;

export const followCopy = async (path: string, change: Change): Promise<void> => {
    await pause(1500);
    await change(path, { state: `copying`, status: `connecting-beta` });
    await pause(1500);
    await change(path, { state: `copying`, status: `scanning` });
    await pause(1200);
    await change(path, { state: `copying`, status: `reconciling`, copy: COPY });
    await pause(800);
    for (let staged = 0; staged <= COPY.files; staged += BATCH) {
        const stagedBytes = Math.round((COPY.bytes * staged) / COPY.files);
        await change(path, { state: `copying`, status: `staging-beta`, copy: { ...COPY, stagedFiles: staged, stagingFiles: COPY.files, stagedBytes } });
        await pause(700);
    }
    await change(path, { state: `copying`, status: `transitioning`, copy: COPY });
    await pause(1000);
    await change(path, { state: `ready`, status: `watching` });
};
