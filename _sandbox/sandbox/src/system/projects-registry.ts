import { join } from "node:path";
import { type DeviceReport, isProjectDirName, projectDirNameOf } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
import { openEntries } from "../store/open-document.js";

// A PROJECTS HOST (config.sandbox.projectsHost, system/project-dir.ts) is this computer's own sandbox: the desktop app
// makes it with no folder, and the owner's folders attach to it later (`intentic-machine sync attach`), each synced into
// `/work/<name>` of its own. The daemon learns of each from the machine agent's sync report and keeps the names here, on
// /history, so a boot re-ensures every one's repo and note before any report arrives (bootstrap/projects/projects-host.ts). Never
// taken from: a folder detached on the computer leaves its copy, its repo and its history here as they were.
//
// THE FOLDER MAP LIVES HERE (2026-10-12): each entry also keeps where the folder is on the owner's computer, as the report
// names it, so the sandbox itself can turn `/work/code-app/src/x.ts` into `C:\Users\radar\code\app\src\x.ts` and back
// (the workspace's AGENTS.md lists them for its agents, project-note.ts). Rejected: deriving `/work` paths from host paths
// (`/work/c/Users/…`), which ties a project's identity to where its folder sits and puts spaces and the owner's account
// name into every path agents work in.

const AttachedProjectSchema = z.object({
    // The folder's name under the workspace root, `/work/<name>` in the container (sandbox-contract's ids/project-dir.ts).
    name: z.string(),
    // When the report that first named it was taken in.
    attachedAt: z.number(),
    // Where the folder is on the owner's computer, as its machine agent names it (`C:\Users\…\app`, a WSL distro's
    // `\\wsl.localhost\<distro>\…`). Absent for an entry kept before the map was, until the next report.
    hostPath: z.string().optional(),
    // Which computer that is, by the name its system gives it (the report's `hostname`).
    machine: z.string().optional(),
});
export type AttachedProject = z.infer<typeof AttachedProjectSchema>;

/** A folder a report names: its `/work` name, and where it is on the computer that reported it. */
export interface ReportedProject {
    name: string;
    hostPath?: string;
    machine?: string;
}

export const attachedProjectsDocument = defineDocument({ root: "history", path: "projects.json", schema: AttachedProjectSchema, granularity: "entries" });

// One entry per name. One whose name is no project folder's (a hand edit) is set aside like an entry the schema refuses,
// so nothing downstream ever joins it onto the workspace root.
const projectsFile = (historyRoot: string): JsonFile<AttachedProject[]> =>
    openEntries(attachedProjectsDocument, join(historyRoot, attachedProjectsDocument.path), {
        idKeys: ["name"],
        read: (entry) => (isProjectDirName(entry.name) ? entry : undefined),
    });

// The attached folders' names, in the order they attached.
export const attachedProjects = async (historyRoot: string): Promise<string[]> => (await attachedProjectEntries(historyRoot)).map((entry) => entry.name);

// The attached folders whole, where each is on the owner's computer included, in the order they attached.
export const attachedProjectEntries = async (historyRoot: string): Promise<AttachedProject[]> => projectsFile(historyRoot).read();

// An entry with where its folder is, as `place` says it; the place a report names nothing of is left as it was.
const placed = (entry: AttachedProject, place: Omit<ReportedProject, "name">): AttachedProject => {
    const next: AttachedProject = { ...entry };
    if (place.hostPath !== undefined) {
        next.hostPath = place.hostPath;
    }
    if (place.machine !== undefined) {
        next.machine = place.machine;
    }
    return next;
};

// True when the name was new. One already attached, or no project folder's name, writes nothing. `place` is where the
// folder is on the owner's computer, kept with it.
export const registerProject = async (
    historyRoot: string,
    name: string,
    now: number = Date.now(),
    place: Omit<ReportedProject, "name"> = {},
): Promise<boolean> => {
    if (!isProjectDirName(name)) {
        return false;
    }
    let added = false;
    await projectsFile(historyRoot).update((current) => {
        if (current.some((entry) => entry.name === name)) {
            return current;
        }
        added = true;
        return [...current, placed({ name, attachedAt: now }, place)];
    });
    return added;
};

// Where folders already attached are on the owner's computer, as a report says it now: a folder moved on the computer, or
// one attached before the map was kept. True when any entry changed; a report saying what is kept already writes nothing,
// which is nearly every report.
export const placeProjects = async (historyRoot: string, reported: readonly ReportedProject[]): Promise<boolean> => {
    const said = new Map(reported.map((project) => [project.name, project]));
    let changed = false;
    await projectsFile(historyRoot).update((current) => {
        const next = current.map((entry) => {
            const place = said.get(entry.name);
            if (place === undefined) {
                return entry;
            }
            const moved = placed(entry, place);
            if (moved.hostPath === entry.hostPath && moved.machine === entry.machine) {
                return entry;
            }
            changed = true;
            return moved;
        });
        return changed ? next : current;
    });
    return changed;
};

// The folders a report syncs into this sandbox, by name, each with where it is on the reporting computer: every pairing
// that syncs files into `/work/<name>`. The report came in on this sandbox's own sync token, and the agent posts a
// sandbox only its own pairings, so none of these is another sandbox's. A mirror-only pairing and the projects host's own
// folderless one name no folder, and neither does a pairing of /work itself. `remoteDir` is the agent's word for the
// folder, so it is read against the container's root. One name named twice is the first pairing's.
export const reportedProjects = (report: DeviceReport): ReportedProject[] => {
    const byName = new Map<string, ReportedProject>();
    for (const pairing of report.pairings) {
        const name = pairing.mode === "sync" && pairing.remoteDir !== undefined ? projectDirNameOf(pairing.remoteDir) : undefined;
        if (name !== undefined && !byName.has(name)) {
            const project: ReportedProject = { name };
            if (pairing.localDir !== undefined && pairing.localDir !== "") {
                project.hostPath = pairing.localDir;
            }
            const machine = report.hostname.trim();
            if (machine !== "") {
                project.machine = machine;
            }
            byName.set(name, project);
        }
    }
    return [...byName.values()];
};
