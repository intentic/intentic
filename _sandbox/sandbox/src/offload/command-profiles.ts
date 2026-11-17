import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";
import { undefinedIfMissing } from "@intentic/base/errors";
import { type CommandProfile, CommandProfileSchema } from "@intentic/sandbox-contract/schemas/offload";
import { z } from "zod";

/* WHAT EACH KIND OF HEAVY LINE TOOK, the last few times a runner ran it (RunnerCommand exit's `peakMemoryMb` and
   `durationMs`). The fleet places the next run of the same kind by it (runners/fleet-advice.ts `placeCommand`): a line
   that held 14 GiB is never sent to a machine with 8 free, and one that finished in seconds stays here while this
   sandbox is merely busy, since a snapshot and a round trip would cost more than the wait. Kept on /history, a few
   hundred kinds at most; a kind nobody ran for longest goes first.

   A kind is the rule the line matched and the parts of it that decide its size: for cargo the verb and the packages,
   targets, profile and features (`cargo test -p shinobi-society --release`), never a test filter or `-j`, so every
   filtered run of one suite counts towards one profile. For anything else, the program and its first two words. */

const PROFILES_FILE = "offload-profiles.json";
const MAX_KINDS = 300;
// Memory is planned for the worst of the last few runs; time is a moving average.
const PEAKS_KEPT = 5;
const DURATION_WEIGHT = 0.3;

// Cargo flags whose value decides what is built, and switches that do.
const CARGO_VALUED = new Set(["-p", "--package", "--bin", "--test", "--example", "--bench", "--target", "--profile", "--features", "-F", "--manifest-path"]);
const CARGO_SWITCHES = new Set(["--workspace", "--all", "--lib", "--bins", "--tests", "--release", "-r", "--all-targets", "--all-features", "--doc", "--no-default-features"]);

const unquote = (word: string): string => word.replace(/^['"]|['"]$/gu, "");

const cargoKey = (words: readonly string[]): string => {
    let index = 1;
    if (words[index]?.startsWith("+") === true) {
        index += 1;
    }
    const verb = words[index] ?? "";
    const sized: string[] = [];
    for (let at = index + 1; at < words.length; at += 1) {
        const word = words[at] ?? "";
        if (word === "--") {
            break;
        }
        if (CARGO_VALUED.has(word)) {
            sized.push(`${word} ${words[at + 1] ?? ""}`);
            at += 1;
        } else if (CARGO_SWITCHES.has(word) || /^-(p|F)\S+$/u.test(word) || /^--(package|features|profile|target|bin|test)=/u.test(word)) {
            sized.push(word);
        }
    }
    return ["cargo", verb, ...sized.toSorted()].join(" ").trim();
};

/** The kind a line is profiled under. */
export const commandKey = (label: string, command: string): string => {
    const words = command
        .split(/\s+/u)
        .filter((word) => word !== "")
        .slice(0, 64)
        .map(unquote);
    const program = basename(words[0] ?? "");
    if (program === "cargo") {
        return `${label}: ${cargoKey(words)}`;
    }
    return `${label}: ${[program, ...words.slice(1, 3)].join(" ")}`.trim();
};

const StoredSchema = CommandProfileSchema.extend({ peaks: z.array(z.number().int().nonnegative()).default([]) });
type Stored = z.infer<typeof StoredSchema>;
const FileSchema = z.object({ profiles: z.array(StoredSchema).default([]) });

export interface Measured {
    readonly peakMemoryMb?: number | undefined;
    readonly durationMs?: number | undefined;
}

export interface CommandProfiles {
    readonly lookup: (label: string, command: string) => Promise<CommandProfile | undefined>;
    readonly record: (label: string, command: string, measured: Measured) => Promise<void>;
    readonly list: () => Promise<CommandProfile[]>;
}

const publicOf = ({ peaks: _peaks, ...profile }: Stored): CommandProfile => profile;

// A torn or hand-broken file reads as empty, which the schema then refuses: profiles relearn in a few runs.
const parseJson = (text: string): ReturnType<typeof JSON.parse> => {
    try {
        return JSON.parse(text);
    } catch {
        // allow(silent-catch): see above; nothing in this file is worth refusing a placement over
        return {};
    }
};

const updated = (previous: Stored | undefined, key: string, measured: Measured, now: number): Stored => {
    const peaks = [...(previous?.peaks ?? []), ...(measured.peakMemoryMb === undefined ? [] : [measured.peakMemoryMb])].slice(-PEAKS_KEPT);
    const lastDuration = previous?.durationMs;
    const durationMs =
        measured.durationMs === undefined
            ? lastDuration
            : lastDuration === undefined
              ? measured.durationMs
              : Math.round(lastDuration * (1 - DURATION_WEIGHT) + measured.durationMs * DURATION_WEIGHT);
    const profile: Stored = { key, runs: (previous?.runs ?? 0) + 1, lastAt: now, peaks };
    if (peaks.length > 0) {
        profile.peakMemoryMb = Math.max(...peaks);
    }
    if (durationMs !== undefined) {
        profile.durationMs = durationMs;
    }
    return profile;
};

export const fileCommandProfiles = (historyRoot: string, now: () => number = Date.now): CommandProfiles => {
    const path = join(historyRoot, PROFILES_FILE);
    let loaded: Promise<Map<string, Stored>> | undefined;
    let writing: Promise<void> = Promise.resolve();

    const load = (): Promise<Map<string, Stored>> => {
        loaded ??= (async () => {
            const text = await readFile(path, "utf8").catch(undefinedIfMissing);
            if (text === undefined) {
                return new Map<string, Stored>();
            }
            const parsed = FileSchema.safeParse(parseJson(text));
            return new Map((parsed.success ? parsed.data.profiles : []).map((profile) => [profile.key, profile]));
        })();
        return loaded;
    };

    const save = (profiles: Map<string, Stored>): Promise<void> => {
        const kept = [...profiles.values()].toSorted((left, right) => right.lastAt - left.lastAt).slice(0, MAX_KINDS);
        writing = writing.then(() => writeFileAtomic(path, `${JSON.stringify({ profiles: kept }, null, 1)}\n`));
        return writing;
    };

    return {
        lookup: async (label, command) => {
            const found = (await load()).get(commandKey(label, command));
            return found === undefined ? undefined : publicOf(found);
        },
        record: async (label, command, measured) => {
            if (measured.peakMemoryMb === undefined && measured.durationMs === undefined) {
                return;
            }
            const profiles = await load();
            const key = commandKey(label, command);
            profiles.set(key, updated(profiles.get(key), key, measured, now()));
            if (profiles.size > MAX_KINDS) {
                const oldest = [...profiles.values()].toSorted((left, right) => left.lastAt - right.lastAt)[0];
                if (oldest !== undefined) {
                    profiles.delete(oldest.key);
                }
            }
            await save(profiles);
        },
        list: async () => [...(await load()).values()].toSorted((left, right) => right.lastAt - left.lastAt).map(publicOf),
    };
};
