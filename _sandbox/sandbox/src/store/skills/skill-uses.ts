import { join } from "node:path";
import { z } from "zod";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { SKILL_USES_WINDOW_DAYS, type SkillUses } from "@intentic/sandbox-contract/schemas/settings";
import { defineDocument } from "../evolution/documents.js";
import { openDocument } from "../open-document.js";

/* WHICH SKILLS TURNS LOADED (historyRoot/skill-uses.json), joined onto the Skills list as "used N times this week".

   A use is one turn that loaded the skill, however many times it did: read off the turn's own tool-call frames, which
   every runtime the daemon drives emits in one vocabulary, so the count holds wherever a turn runs. A turn loads a skill
   one of two ways: through a skill tool naming it (Claude's `Skill`, OpenCode's `skill`), or, on a runtime whose loader
   does not list the workspace's skills, by reading its SKILL.md with a file tool or the shell, as the catalogue note
   (loaded-skills.ts) tells it to.

   Keyed by skill name, the one key the list's rows share across origins; per name, the newest instant and each turn's
   instant inside the window, pruned on every write. Nothing finer is kept: which conversation loaded it is the
   transcript's to say. */

const WINDOW_MS = SKILL_USES_WINDOW_DAYS * 24 * 3_600_000;
// A skill loaded by every turn of a busy week stays a few kilobytes; past this the oldest instants go first, which
// undercounts only a week that would read as "a lot" anyway.
const RECENT_CAP = 2_000;

const SkillUseSchema = z.object({
    // Epoch ms of the newest turn that loaded it, kept past the window so "last used" outlives a quiet week.
    last: z.number(),
    // Epoch ms of each turn that loaded it inside the window, oldest first.
    recent: z.array(z.number()),
});
type SkillUse = z.infer<typeof SkillUseSchema>;

export const skillUsesDocument = defineDocument({
    root: "history",
    path: "skill-uses.json",
    // Says what this machine's turns did; a restored sandbox starts its own count rather than carrying another's week.
    portability: "derived",
    schema: SkillUseSchema,
    granularity: "record",
});

const usesFile = (historyRoot: string) =>
    openDocument(skillUsesDocument, join(historyRoot, skillUsesDocument.path), { fallback: (): Record<string, SkillUse> => ({}) });

/** Adds one turn's loads at `at`. Callers fire and forget: a lost count is cheaper than a turn held on a write. */
export const recordSkillUses = async (historyRoot: string, names: readonly string[], at: number = Date.now()): Promise<void> => {
    if (names.length === 0 || historyRoot === "") {
        return;
    }
    const cutoff = at - WINDOW_MS;
    await usesFile(historyRoot).update((all) => {
        const next: Record<string, SkillUse> = {};
        // Every entry is pruned, not just the ones this turn touched, so a skill nobody loads stops costing its instants.
        for (const [name, use] of Object.entries(all)) {
            next[name] = { last: use.last, recent: use.recent.filter((instant) => instant > cutoff) };
        }
        for (const name of new Set(names)) {
            const before = next[name];
            next[name] = { last: Math.max(before?.last ?? at, at), recent: [...(before?.recent ?? []), at].slice(-RECENT_CAP) };
        }
        return next;
    });
};

/** Every skill's count as the list shows it, by name; a name absent here was never loaded since the count began. */
export const readSkillUses = async (historyRoot: string, now: number = Date.now()): Promise<ReadonlyMap<string, SkillUses>> => {
    const counts = new Map<string, SkillUses>();
    if (historyRoot === "") {
        return counts;
    }
    const cutoff = now - WINDOW_MS;
    for (const [name, use] of Object.entries(await usesFile(historyRoot).read())) {
        counts.set(name, { week: use.recent.filter((instant) => instant > cutoff).length, last: new Date(use.last).toISOString() });
    }
    return counts;
};

// What a call is read off: its kind, its name, and the places its words could name a SKILL.md.
type CallFrame = Pick<Extract<AgentEvent, { kind: "tool_call" }>, "name" | "category" | "target" | "input" | "locations">;

// A SKILL.md under any `skills/<name>/`: the loaded folder, the image's own, a role kit's. The character before `skills`
// must end a path segment or a word, so `myskills/x/SKILL.md` names nothing.
const SKILL_FILE_PATH = /(?:^|[/\s'"`=])skills\/([A-Za-z0-9][\w.-]*)\/SKILL\.md(?![\w.])/g;
// A shell call counts only when it reads: an edit, a move or a removal of the file is not the agent taking it in.
const SHELL_READER = /(?:^|[\s;&|(])(?:cat|head|tail|less|more|bat|sed|nl|awk|Get-Content|type)\s/;
// The skill tool's argument, read off the bounded input text rather than parsed, since a long input arrives cut short.
const SKILL_ARGUMENT = /"(?:skill|name)"\s*:\s*"([^"]+)"/;

// The list names a plugin's skill by its folder, where a skill tool spells it `<plugin>:<name>`.
const listedName = (called: string): string => called.slice(called.lastIndexOf(":") + 1);

const pathsIn = (text: string | undefined): string[] => (text === undefined ? [] : [...text.matchAll(SKILL_FILE_PATH)].map((match) => match[1] ?? "").filter((name) => name !== ""));

/** The skills one call loads, by the name the list shows; empty for every other call. */
export const skillsLoadedBy = (call: CallFrame): string[] => {
    if (call.name.toLowerCase() === "skill") {
        const called = call.input === undefined ? undefined : SKILL_ARGUMENT.exec(call.input)?.[1];
        return called === undefined ? [] : [listedName(called)];
    }
    if (call.category === "read") {
        return [...pathsIn(call.target), ...(call.locations ?? []).flatMap((location) => pathsIn(`/${location.path}`)), ...pathsIn(call.input)];
    }
    if (call.category === "execute" && call.target !== undefined && SHELL_READER.test(call.target)) {
        return pathsIn(call.target);
    }
    return [];
};

export interface SkillLoads {
    readonly note: (event: AgentEvent) => void;
    // Each skill the turn loaded, once.
    readonly reading: () => readonly string[];
}

/** The turn's fold: every call it makes, a subagent's included, since a skill a subagent loaded is one the turn used. */
export const createSkillLoads = (): SkillLoads => {
    const loaded = new Set<string>();
    // A runtime that sends a call's input only on a later update (ACP) is read again then, against what the call was.
    const calls = new Map<string, Pick<CallFrame, "name" | "category">>();
    const add = (call: CallFrame): void => {
        for (const name of skillsLoadedBy(call)) {
            loaded.add(name);
        }
    };
    return {
        note: (event) => {
            if (event.kind === "tool_call") {
                calls.set(event.id, { name: event.name, category: event.category });
                add(event);
            } else if (event.kind === "tool_call_update" && event.input !== undefined) {
                const call = calls.get(event.id);
                if (call !== undefined) {
                    add({ ...call, input: event.input, target: undefined, locations: event.locations });
                }
            }
        },
        reading: () => [...loaded],
    };
};
