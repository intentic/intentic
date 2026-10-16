import { KEYRING_PACKAGE_RE, KEYRING_PROGRAM_MAX, KEYRING_PROGRAMS_MAX } from "@intentic/sandbox-contract/schemas/keyring";
import type { SecretProgramGuard } from "@intentic/sandbox-contract/schemas/secrets";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// The program guard, the host guard's counterpart for typing (schemas/secrets.ts SecretProgramsSchema): which programs on
// the owner's computers, and which phone apps, a sandbox-held secret may be typed into without a person saying so, and
// whether into a field the program does not mark as a password field. Unset, every typing asks. Stored off the workspace
// beside the host guards (mode 0600), since `.intentic/config/` is agent-editable and a turn must not widen its own
// guard. A secret a computer's keyring holds carries its own list, kept on that computer; this store never has one.

// name -> setting. Programs and packages kept as plain strings and checked on read, so a rule a later build tightens
// drops an entry (a tighter list) instead of making the whole file unreadable.
export const secretProgramGuardsDocument = defineDocument({
    root: "auth",
    path: "secret-programs.json",
    schema: z.object({ programs: z.array(z.string()), packages: z.array(z.string()), anyField: z.boolean() }),
    granularity: "record",
});

export interface ProgramGuard {
    readonly programs: readonly string[];
    readonly packages: readonly string[];
    readonly anyField: boolean;
}

// What an unset guard means: nothing goes unasked.
export const NO_PROGRAMS: ProgramGuard = { programs: [], packages: [], anyField: false };

export interface SecretProgramGuardsStore {
    // Every secret whose list was set; throws when the file exists but cannot be read, since empty here would read as
    // nothing guarded, which for this guard is the strict reading but not what the owner wrote.
    readonly list: () => Promise<readonly SecretProgramGuard[]>;
    // One secret's list, the empty one when unset.
    readonly guardFor: (name: string) => Promise<ProgramGuard>;
    // Replaces one secret's list; the empty, strict one removes it.
    readonly set: (subject: string, guard: ProgramGuard) => Promise<void>;
}

const PROGRAM_OK = (program: string): boolean => program.length > 0 && program.length <= KEYRING_PROGRAM_MAX && !/[\0\r\n]/u.test(program);
const PACKAGE_OK = (pkg: string): boolean => pkg.length <= 255 && KEYRING_PACKAGE_RE.test(pkg);

const checked = (entry: { readonly programs: readonly string[]; readonly packages: readonly string[]; readonly anyField: boolean }): ProgramGuard => ({
    programs: [...new Set(entry.programs.filter(PROGRAM_OK))].slice(0, KEYRING_PROGRAMS_MAX),
    packages: [...new Set(entry.packages.filter(PACKAGE_OK))].slice(0, KEYRING_PROGRAMS_MAX),
    anyField: entry.anyField,
});

export const isStrict = (guard: ProgramGuard): boolean => guard.programs.length === 0 && guard.packages.length === 0 && !guard.anyField;

// Whether `next` lets anything go unasked that `current` did not: a program or an app added, or `anyField` turned on.
// Taking either away, or turning it off, only asks more often.
export const widensPrograms = (current: ProgramGuard, next: ProgramGuard): boolean =>
    next.programs.some((program) => !current.programs.some((held) => held.toLowerCase() === program.toLowerCase())) ||
    next.packages.some((pkg) => !current.packages.includes(pkg)) ||
    (next.anyField && !current.anyField);

export const fileSecretProgramGuards = (path: string): SecretProgramGuardsStore => {
    const file = openDocument(secretProgramGuardsDocument, path, {
        fallback: (): Record<string, { programs: string[]; packages: string[]; anyField: boolean }> => ({}),
        mode: 0o600,
        // A fresh store over an unreadable one would drop every list the owner wrote.
        onUnreadable: "refuse",
    });
    const read = async (): Promise<Readonly<Record<string, ProgramGuard>>> => {
        const state = await file.state();
        if (state.unreadable) {
            throw new Error(`the secret program guards at ${path} could not be read (${state.detail})`);
        }
        return Object.fromEntries(Object.entries(state.value).map(([subject, entry]) => [subject, checked(entry)]));
    };
    return {
        list: async () => Object.entries(await read()).map(([subject, guard]) => ({ subject, programs: [...guard.programs], packages: [...guard.packages], anyField: guard.anyField })),
        guardFor: async (name) => (await read())[name] ?? NO_PROGRAMS,
        set: async (subject, guard) => {
            const kept = checked(guard);
            await file.update((current) => {
                if (isStrict(kept)) {
                    if (!(subject in current)) {
                        return current;
                    }
                    const { [subject]: _dropped, ...rest } = current;
                    return rest;
                }
                return { ...current, [subject]: { programs: [...kept.programs], packages: [...kept.packages], anyField: kept.anyField } };
            });
        },
    };
};
