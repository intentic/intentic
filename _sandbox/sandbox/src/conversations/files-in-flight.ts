import type { Logger } from "pino";
import { mapPool } from "@intentic/base/async";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import { parentOfActor } from "../auth/principal.js";
import { IN_FLIGHT_NOTE_HEADER, IN_FLIGHT_NOTE_TITLE } from "../sessions/vocabulary/prompt-envelope.js";
import { opt } from "../opt.js";
import type { UnlandedPaths } from "./land/branch/unlanded-paths.js";
import type { IsolatedAgent, PersistedAgent } from "./registry/agents-store.js";
import { sharedTitleOf } from "./seal/seal-family.js";

// FILES IN FLIGHT: which files each live conversation has changed on its branch and not landed, so a conversation about
// to change one of them hears who else is, once. Parallel conversations in one workspace duplicated and collided because
// none knew what the others were changing (2026-11-17, the shinobi-society audit: the owner had to write "Do not collide
// with jet-dewt" into a task by hand).
//
// Read from git only when a turn settles or a land moves a branch (each conversation's anchor..tip, as its land measures
// it), never per keystroke; between those, a turn's own edits are added as its edit hook sees them, which costs nothing.
// Paths are workspace-relative, a nested repo's under its folder, so one path names one file whichever repo holds it.
// Kept in memory: a restart reads every live conversation again, and the pairs already told start over.

// One conversation's reading: its unlanded paths, and the branch tip each repo was read at.
export type InFlightReading = UnlandedPaths;

// What a reading is made of: the daemon asks git (land/branch/unlanded-paths.ts), a suite hands its own. Taken, not imported,
// so the conversations slice that builds the index reaches no land code through it.
export type InFlightReader = (entry: IsolatedAgent) => Promise<InFlightReading>;

/** One other conversation that holds some of the same files, and which. */
export interface InFlightOverlap {
    readonly id: string;
    readonly title?: string;
    readonly paths: readonly string[];
}

export interface FilesInFlight {
    // Reads one conversation again; it leaves the index when it holds nothing unlanded, or is gone, archived, or works in
    // the shared tree. Never throws: a reading that fails keeps the last one.
    readonly refresh: (id: string) => Promise<void>;
    // Every live conversation, a couple at a time: what a boot reads before anything settles.
    readonly refreshLive: () => Promise<void>;
    // A file this conversation's turn just changed, kept without git until its next reading; answers the one line it is
    // owed about other conversations changing the same file, or undefined when there are none it was not told of.
    readonly edited: (id: string, path: string) => string | undefined;
    // What a turn opens with: the conversations changing files this one already changed, those it was not told of yet.
    readonly turnNote: (id: string) => TurnNote | undefined;
    // Every conversation holding this path, or anything under it when it names a folder, with the paths that matched.
    readonly touching: (path: string) => ReadonlyMap<string, readonly string[]>;
    // This conversation's own unlanded paths, sorted.
    readonly pathsOf: (id: string) => readonly string[];
    // The others holding any of this conversation's paths (lineage left out, as everywhere here).
    readonly overlapsOf: (id: string) => readonly InFlightOverlap[];
    // Who holds anything at all.
    readonly holders: () => readonly string[];
    // The branch tip one repo of a conversation was last read at.
    readonly tipOf: (id: string, repo: string) => string | undefined;
}

type Registry = { readonly ids: () => readonly string[]; readonly entry: (id: string) => PersistedAgent | undefined };

export interface FilesInFlightDeps {
    readonly agents: Registry;
    readonly read: InFlightReader;
    readonly logger: Pick<Logger, "warn">;
}

// How far up a parent chain is followed; a family deeper than this is not one the sandbox spawns.
const LINEAGE_DEPTH = 16;
// How many conversations a turn's opening note names, and how many paths under each.
const NAMED_OTHERS = 5;
const NAMED_PATHS = 3;

interface Held {
    // From the last reading, plus what the turn edited since.
    readonly paths: Set<string>;
    readonly tips: ReadonlyMap<string, string>;
}

// A conversation on a branch of its own, live: the only kind that holds anything. (agents-store.ts isIsolated, read by
// its shape here so this module imports no registry code.)
const holding = (entry: PersistedAgent | undefined): entry is IsolatedAgent => entry !== undefined && entry.placement.kind === "worktree" && entry.archivedAt === undefined;

// `.` names the whole tree; `./x` and `x/` name what `x` does.
const clean = (path: string): string => (path === "." ? "" : path.replace(/^\.\//u, "").replace(/\/+$/u, ""));

const listed = (paths: readonly string[], named: number): string =>
    [...paths.slice(0, named).map((path) => `\`${path}\``), ...(paths.length > named ? [`${paths.length - named} more`] : [])].join(", ");

// Every conversation above this one: the parent that started it, and that parent's, up the chain.
const ancestorsOf = (agents: Registry, id: string): Set<string> => {
    const above = new Set<string>();
    let at = parentOfActor(agents.entry(id)?.identity.startedBy);
    while (at !== undefined && !above.has(at) && above.size < LINEAGE_DEPTH) {
        above.add(at);
        at = parentOfActor(agents.entry(at)?.identity.startedBy);
    }
    return above;
};

// A parent and the children it delegated to share files on purpose: neither is news to the other.
const kin = (agents: Registry, a: string, b: string): boolean => ancestorsOf(agents, a).has(b) || ancestorsOf(agents, b).has(a);

// Who may be named to another conversation: a live one that is not private.
const nameable = (agents: Registry, id: string): PersistedAgent | undefined => {
    const entry = agents.entry(id);
    return entry === undefined || entry.archivedAt !== undefined || entry.seal !== undefined ? undefined : entry;
};

// A conversation as a line names it: its id, and its task where it has a title.
const nameOf = (agents: Registry, id: string): string => {
    const entry = nameable(agents, id);
    const title = entry === undefined ? undefined : sharedTitleOf(entry);
    return title === undefined ? `\`${id}\`` : `\`${id}\` ("${title}")`;
};

const editedLine = (agents: Registry, file: string, changing: readonly string[]): string =>
    `Heads-up: \`${file}\` is also changed, not yet landed, by ${changing.map((id) => nameOf(agents, id)).join(" and ")}. ` +
    `\`agents show ${changing[0] ?? ""}\` says what it is doing; coordinate before changing it further.`;

const openingNote = (agents: Registry, overlaps: readonly InFlightOverlap[]): TurnNote | undefined =>
    overlaps.length === 0
        ? undefined
        : {
              title: IN_FLIGHT_NOTE_TITLE,
              text: [
                  IN_FLIGHT_NOTE_HEADER,
                  "",
                  "Files this conversation changed are also changed, not yet landed, by other conversations in this workspace. Coordinate before changing them further (`agents show <id>` says what each is doing):",
                  ...overlaps.slice(0, NAMED_OTHERS).map((overlap) => `- ${nameOf(agents, overlap.id)}: ${listed(overlap.paths, NAMED_PATHS)}`),
              ].join("\n"),
          };

// The index itself: one reading per conversation holding anything, one reading in flight per conversation at a time.
const heldReadings = ({ agents, read, logger }: FilesInFlightDeps) => {
    const held = new Map<string, Held>();
    const reading = new Map<string, Promise<void>>();
    const readOne = async (id: string): Promise<void> => {
        const entry = agents.entry(id);
        if (!holding(entry) || entry.placement.runner !== undefined) {
            held.delete(id);
            return;
        }
        try {
            const { paths, tips } = await read(entry);
            if (paths.length === 0) {
                held.delete(id);
                return;
            }
            held.set(id, { paths: new Set(paths), tips });
        } catch (error) {
            logger.warn({ err: error, conversationId: id }, "files in flight: a conversation's unlanded files could not be read, its last reading stands");
        }
    };
    const refresh = (id: string): Promise<void> => {
        const next = (reading.get(id) ?? Promise.resolve()).then(() => readOne(id));
        reading.set(id, next);
        return next.finally(() => {
            if (reading.get(id) === next) {
                reading.delete(id);
            }
        });
    };
    // A file a turn changed between readings; only a conversation on a branch of its own holds anything.
    const note = (id: string, file: string): void => {
        if (!holding(agents.entry(id))) {
            return;
        }
        const mine = held.get(id);
        if (mine === undefined) {
            held.set(id, { paths: new Set([file]), tips: new Map() });
        } else {
            mine.paths.add(file);
        }
    };
    return { held, refresh, note };
};

export const createFilesInFlight = (deps: FilesInFlightDeps): FilesInFlight => {
    const { agents } = deps;
    const { held, refresh, note } = heldReadings(deps);
    // Who was told about whom, `${to}\0${about}`: a pair is said once, at a turn's opening or at an edit, never again.
    const told = new Set<string>();
    const tell = (to: string, about: string): boolean => {
        const pair = `${to}\0${about}`;
        const fresh = !told.has(pair);
        told.add(pair);
        return fresh;
    };
    // The holders this conversation may hear about, among those `holds` picks: never itself, its family or a private one.
    // Asked on every edit, so the cheap test on the paths runs before the walk up the families.
    const others = (id: string, holds: (paths: ReadonlySet<string>) => boolean = () => true): string[] =>
        [...held]
            .filter(([other, { paths }]) => other !== id && holds(paths))
            .map(([other]) => other)
            .filter((other) => !kin(agents, id, other) && nameable(agents, other) !== undefined);
    const overlapsOf = (id: string): InFlightOverlap[] => {
        const mine = held.get(id)?.paths ?? new Set<string>();
        return others(id).flatMap((other) => {
            const paths = [...(held.get(other)?.paths ?? [])].filter((path) => mine.has(path)).toSorted();
            const entry = nameable(agents, other);
            return paths.length === 0 ? [] : [{ id: other, ...opt("title", entry === undefined ? undefined : sharedTitleOf(entry)), paths }];
        });
    };
    return {
        refresh,
        refreshLive: () =>
            mapPool(
                agents.ids().filter((id) => holding(agents.entry(id))),
                2,
                refresh,
            ),
        edited: (id, path) => {
            const file = clean(path);
            note(id, file);
            const changing = others(id, (paths) => paths.has(file)).filter((other) => tell(id, other));
            return changing.length === 0 ? undefined : editedLine(agents, file, changing);
        },
        turnNote: (id) => openingNote(agents, overlapsOf(id).filter((overlap) => tell(id, overlap.id))),
        touching: (path) => {
            const wanted = clean(path);
            const found = new Map<string, readonly string[]>();
            for (const [id, { paths }] of held) {
                // Archived since its last reading: it holds nothing any more, whatever was read then.
                if (!holding(agents.entry(id))) {
                    continue;
                }
                const matched = [...paths].filter((each) => wanted === "" || each === wanted || each.startsWith(`${wanted}/`)).toSorted();
                if (matched.length > 0) {
                    found.set(id, matched);
                }
            }
            return found;
        },
        pathsOf: (id) => [...(held.get(id)?.paths ?? [])].toSorted(),
        overlapsOf,
        holders: () => [...held.keys()].filter((id) => holding(agents.entry(id))),
        tipOf: (id, repo) => held.get(id)?.tips.get(repo),
    };
};
