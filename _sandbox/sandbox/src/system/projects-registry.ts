import { join } from "node:path";
import { type DeviceReport, isProjectDirName, projectDirNameOf } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
import { openEntries } from "../store/open-document.js";

// A PROJECTS HOST (config.sandbox.projectsHost, system/project-dir.ts) is this computer's own sandbox: the desktop app
// makes it with no folder, and the owner's folders attach to it later (`intentic-machine sync attach`), each synced into
// `/work/<name>` of its own. The daemon learns of each from the machine agent's sync report and keeps the names here, on
// /history, so a boot re-ensures every one's repo and note before any report arrives (bootstrap/projects-host.ts). Only
// ever added to: a folder detached on the computer leaves its copy, its repo and its history here as they were.

const AttachedProjectSchema = z.object({
    // The folder's name under the workspace root, `/work/<name>` in the container (sandbox-contract's ids/project-dir.ts).
    name: z.string(),
    // When the report that first named it was taken in.
    attachedAt: z.number(),
});
type AttachedProject = z.infer<typeof AttachedProjectSchema>;

export const attachedProjectsDocument = defineDocument({ root: "history", path: "projects.json", schema: AttachedProjectSchema, granularity: "entries" });

// One entry per name. One whose name is no project folder's (a hand edit) is set aside like an entry the schema refuses,
// so nothing downstream ever joins it onto the workspace root.
const projectsFile = (historyRoot: string): JsonFile<AttachedProject[]> =>
    openEntries(attachedProjectsDocument, join(historyRoot, attachedProjectsDocument.path), {
        idKeys: ["name"],
        read: (entry) => (isProjectDirName(entry.name) ? entry : undefined),
    });

// The attached folders' names, in the order they attached.
export const attachedProjects = async (historyRoot: string): Promise<string[]> => (await projectsFile(historyRoot).read()).map((entry) => entry.name);

// True when the name was new. One already attached, or no project folder's name, writes nothing.
export const registerProject = async (historyRoot: string, name: string, now: number = Date.now()): Promise<boolean> => {
    if (!isProjectDirName(name)) {
        return false;
    }
    let added = false;
    await projectsFile(historyRoot).update((current) => {
        if (current.some((entry) => entry.name === name)) {
            return current;
        }
        added = true;
        return [...current, { name, attachedAt: now }];
    });
    return added;
};

// The folders a report syncs into this sandbox, by name: every pairing that syncs files into `/work/<name>`. The report
// came in on this sandbox's own sync token, and the agent posts a sandbox only its own pairings, so none of these is
// another sandbox's. A mirror-only pairing and the projects host's own folderless one name no folder, and neither does a
// pairing of /work itself. `remoteDir` is the agent's word for the folder, so it is read against the container's root.
export const reportedProjects = (report: DeviceReport): string[] => [
    ...new Set(
        report.pairings.flatMap((pairing) => {
            const name = pairing.mode === "sync" && pairing.remoteDir !== undefined ? projectDirNameOf(pairing.remoteDir) : undefined;
            return name === undefined ? [] : [name];
        }),
    ),
];
