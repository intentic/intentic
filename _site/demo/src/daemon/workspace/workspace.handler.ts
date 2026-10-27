import { refuse } from "@intentic/contract-serve";
import { demoHealth } from "../../fixture/health";
import { pictureDimensions, readFile, resolveReference, restoreEntry, searchWorkspace } from "../../fixture/workspace";
import { addApps, appsList, startApp, stopApp, templates } from "./apps";
import { derive, readDerived } from "./derived";
import { copyEntry, deleteAny, editedChildren, editedTree, extractArchive, makeFolder, moveEntry, noteWritten } from "./edits";
import { packageGraph, packageModules, workspaceModules } from "./graph";
import { cloneRepo, createRepo, workspaceRepos } from "./repos";
import { streamSearch } from "./searchStream";
import { seedPages } from "./seed";
import { install, runTests } from "./tests";
import { mintDownloadTicket, mintMediaTicket, mintPreviewTicket } from "./tickets";
import { okAfter, type Doors } from "../doors";

// Serves the recording's filesystem like the real daemon: a tree, lazy per-directory listing, and real writes (new
// folders, moves, copies, unpacked archives, cloned repositories) that hold until the tab reloads. The stores behind
// each verb are in daemon/workspace/.

seedPages();

// The search box's options, read the same way by the plain search and its streamed first page.
const searchOptions = (input: { mode?: string; literal?: boolean; word?: boolean; caseSensitive?: boolean; include?: string; dir?: string }) => ({
    smart: input.mode === `q`,
    literal: input.literal === true,
    word: input.word === true,
    caseSensitive: input.caseSensitive === true,
    include: input.include ?? ``,
    dir: input.dir ?? ``,
});

export const workspaceDoors = {
    tree: () => editedTree(),
    children: ({ path }) => editedChildren(path),
    // A missing path answers "nothing there" in a 200 body, not a 404; several surfaces read a file just to check existence.
    file: ({ path }) => readFile(path),
    dimensions: ({ paths }) => pictureDimensions(paths),
    resolve: ({ path }) => resolveReference(path),
    derived: ({ path }) => readDerived(path),
    derive: ({ path }) => derive(path),
    mkdir: ({ path }) => okAfter(() => makeFolder(path)),
    delete: ({ path }) => deleteAny(path),
    restore: ({ trashed }) => {
        const landed = restoreEntry(trashed) ?? refuse(`That is no longer in the trash.`, 404);
        noteWritten([landed.path]);
        return landed;
    },
    move: ({ from, to }) => okAfter(() => moveEntry(from, to)),
    copy: ({ from, to }) => okAfter(() => copyEntry(from, to)),
    extract: ({ path }) => extractArchive(path),
    install: ({ dirs }) => install(dirs),
    repos: () => ({ repos: workspaceRepos() }),
    addRepo: ({ name, cloneUrl }) => cloneRepo(name, cloneUrl),
    createRepo: ({ name }) => createRepo(name),
    modules: () => workspaceModules(),
    templates: () => templates(),
    addApps: ({ repo, apps }) => okAfter(() => addApps(repo, apps)),
    appsList: ({ repo }) => appsList(repo),
    startApp: ({ repo, app }) => okAfter(() => startApp(repo, app)),
    stopApp: ({ repo, app }) => okAfter(() => stopApp(repo, app)),
    runTests: ({ repo, session, dirs }) => okAfter(() => runTests(repo, session, dirs)),
    packageGraph: ({ repo }) => packageGraph(repo),
    packageModules: ({ repo, package: name }) => packageModules(repo, name),
    // The Health tab's report: hotspots and key modules for the shop's repositories (fixture/health.ts).
    health: ({ repo, since }) => demoHealth(repo, since, Date.now()),
    // The tickets an element spends where it cannot send a bearer (daemon/workspace/tickets.ts).
    mediaTicket: ({ path }) => mintMediaTicket(path),
    downloadTicket: ({ paths }) => mintDownloadTicket(paths),
    previewTicket: ({ path, source }) => mintPreviewTicket(path, source),
    search: ({ query, ...options }) => searchWorkspace(query, searchOptions(options)),
    // Text search's first page, its files streamed ahead of it.
    searchStream: ({ query, ...options }) => streamSearch(searchWorkspace(query, searchOptions(options))),
} satisfies Doors<`workspace`>;
