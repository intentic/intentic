import type { PanelStartSource, PanelSummary } from "@intentic/sandbox-contract/schemas/panels";
import type { RepoRunTargets } from "@intentic/sandbox-contract/schemas/run-targets";
import { appTargetId, type PreviewTarget, repoTargetId } from "../../../models/preview/previewModel";

/* WHAT THE RUN DIALOG LISTS FOR ONE REPOSITORY, and where each can run. Pure: the repository's .intentic/run.json, its
   panel row and the live targets in, rows out.
   - Every target the file declares, in its order: one with a `command` runs in the sandbox (as the app
     `<repo>--<name>`, with its own preview), one with an `artifact` on a computer, one with both in either place.
   - When the file declares nothing for the sandbox, what Start finds in the repository's own files (a Procfile, a `dev`
     or `start` script, a Cargo binary) is the sandbox's row, first, so every repository Start can run is runnable here.
   The place is chosen once for the whole list (`SANDBOX` or a computer's id), as the dialog's "where" row shows. */

// The sandbox's place in the "where" row. Not a device id: those are capability card ids, which never hold an `@`.
export const SANDBOX = `@sandbox`;

export interface RunRow {
    // Unique within the repository: the target's name, or FOUND for what Start found.
    readonly key: string;
    // What the row is called: the target's name, or the command Start found (`pnpm dev`).
    readonly name: string;
    readonly description: string | undefined;
    // Where the file says the command came from, for a found row; undefined for a declared target.
    readonly found: PanelStartSource | undefined;
    // The live target it runs as in the sandbox, once listed; `sandboxId` names it before then. Both undefined for a
    // target that runs only on a computer.
    readonly sandboxId: string | undefined;
    readonly sandbox: PreviewTarget | undefined;
    // Whether it carries a build to a computer, and which computer it names first.
    readonly computers: boolean;
    readonly device: string | undefined;
    readonly isolated: boolean;
}

export const FOUND = `@found`;

export const runRowsOf = (
    repo: string,
    declared: RepoRunTargets | undefined,
    panel: PanelSummary | undefined,
    live: readonly PreviewTarget[],
): RunRow[] => {
    const liveById = new Map(live.map((target) => [target.id, target]));
    const rows: RunRow[] = (declared?.targets ?? []).map((target) => {
        const sandboxId = target.command === undefined ? undefined : appTargetId(repo, target.name);
        return {
            key: target.name,
            name: target.name,
            description: target.description,
            found: undefined,
            sandboxId,
            sandbox: sandboxId === undefined ? undefined : liveById.get(sandboxId),
            computers: target.artifact !== undefined,
            device: target.device,
            isolated: target.isolated,
        };
    });
    if (rows.some((row) => row.sandboxId !== undefined) || panel?.start === undefined) {
        return rows;
    }
    const sandboxId = repoTargetId(repo);
    return [
        {
            key: FOUND,
            name: panel.start.command,
            description: undefined,
            found: panel.start.from,
            sandboxId,
            sandbox: liveById.get(sandboxId),
            computers: false,
            device: undefined,
            isolated: false,
        },
        ...rows,
    ];
};

// Whether a row can run in the chosen place.
export const runsAt = (row: RunRow, place: string): boolean => (place === SANDBOX ? row.sandboxId !== undefined : row.computers);

// Where the dialog opens: the first row's own place (the sandbox, or the computer it names when that one can take a
// run), else any computer that can, else the first computer, else the sandbox.
export const defaultPlace = (rows: readonly RunRow[], devices: readonly string[], ready: (device: string) => boolean): string => {
    const [first] = rows;
    if (first === undefined || first.sandboxId !== undefined) {
        return SANDBOX;
    }
    if (first.device !== undefined && devices.includes(first.device) && ready(first.device)) {
        return first.device;
    }
    return devices.find(ready) ?? devices[0] ?? SANDBOX;
};
