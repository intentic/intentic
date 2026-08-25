import {
    type EnvironmentDrift,
    type RuntimeInstall,
    type RuntimeInstallKind,
    type RuntimeInstallsFile,
    RuntimeInstallsFileSchema,
} from "@intentic/sandbox-contract";
import { jsonFile } from "../store/json-file.js";

/* THE RUNTIME-INSTALL LEDGER: which tools sessions installed into the container at runtime, and how often.
 *
 * Anything installed outside /work dies with the container, and the model was never going to be the reliable
 * reporter of that: transcript mining found cargo-xwin reinstalled in six sessions and a Windows rustup target
 * in eight, each time by an agent that had been told, in-context, to also draft an overlay step. So the ledger
 * is written by the HARNESS — the install-steering hook classifies the command and records it here without a
 * word to the model — and read by the drift sweep, which joins it with what the live container actually has
 * and drafts the overlay step itself (auto-drafts.ts).
 *
 * The file lives under /work and so SURVIVES container recreates, which is what makes recurrence observable:
 * "installed again in a fresh container" is precisely the evidence that a tool belongs in the image, and no
 * single container can ever witness it. Sessions are the unit of recurrence, not commands — a session that
 * retries an install five times needed the tool once.
 *
 * The drift snapshot rides in the same file so a daemon restart does not blank the Environment card until the
 * next sweep; it is machine-scoped where the ledger is workspace-scoped, and every reader guards on its bornAt
 * matching the running container (drift.ts) rather than trusting persistence to mean truth. */

// Distinct sessions kept per tool. Recurrence gates on ≥ 2; eight is enough to say "constantly" on the card
// without the file growing with every conversation this workspace ever runs.
const SESSIONS_KEPT = 8;
// Recent commands kept per tool, provenance for the draft's comment, not a history.
const COMMANDS_KEPT = 3;
const COMMAND_MAX_LENGTH = 240;
// Tools kept overall; past this the entry silent longest is dropped. Far above any real workspace — the point
// is that a pathological classifier cannot grow the file without bound, not that eviction ever happens.
const TOOLS_KEPT = 200;

export interface ClassifiedInstall {
    readonly tool: string;
    readonly kind: RuntimeInstallKind;
}

export interface RuntimeInstallsStore {
    readonly read: () => Promise<RuntimeInstallsFile>;
    // One command's worth of classified installs, merged by (kind, tool). `session` absent (a turn with no
    // conversation id) still counts the command and stamps the time, it just cannot add to recurrence.
    readonly record: (installs: readonly ClassifiedInstall[], command: string, session: string | undefined, at: number) => Promise<void>;
    readonly saveDrift: (drift: EnvironmentDrift) => Promise<void>;
    // The owner rejected auto-drafted steps naming these tools: tombstone them so the sweep never proposes the
    // same step again. Without this the auto-drafter would recreate a rejected draft on its next tick, forever.
    readonly decline: (tools: readonly string[], at: number) => Promise<void>;
}

const keyOf = (install: { readonly kind: RuntimeInstallKind; readonly tool: string }): string => `${install.kind}:${install.tool}`;

const merged = (
    current: RuntimeInstall | undefined,
    install: ClassifiedInstall,
    command: string,
    session: string | undefined,
    at: number,
): RuntimeInstall => {
    const trimmed = command.length > COMMAND_MAX_LENGTH ? `${command.slice(0, COMMAND_MAX_LENGTH)}…` : command;
    if (current === undefined) {
        return {
            tool: install.tool,
            kind: install.kind,
            sessions: session === undefined ? [] : [session],
            commands: [trimmed],
            firstAt: at,
            lastAt: at,
            count: 1,
        };
    }
    const sessions =
        session === undefined || current.sessions.includes(session) ? current.sessions : [...current.sessions, session].slice(-SESSIONS_KEPT);
    const commands = current.commands.includes(trimmed) ? current.commands : [...current.commands, trimmed].slice(-COMMANDS_KEPT);
    return { ...current, sessions, commands, lastAt: at, count: current.count + 1 };
};

export const fileRuntimeInstallsStore = (path: string): RuntimeInstallsStore => {
    const file = jsonFile<RuntimeInstallsFile>(path, {
        parse: (raw) => RuntimeInstallsFileSchema.safeParse(raw).data,
        fallback: () => ({ installs: [] }),
    });
    return {
        read: file.read,
        record: async (installs, command, session, at) => {
            if (installs.length === 0) {
                return;
            }
            await file.update((current) => {
                const byKey = new Map(current.installs.map((entry) => [keyOf(entry), entry]));
                for (const install of installs) {
                    byKey.set(keyOf(install), merged(byKey.get(keyOf(install)), install, command, session, at));
                }
                const entries = [...byKey.values()].toSorted((left, right) => right.lastAt - left.lastAt).slice(0, TOOLS_KEPT);
                return { ...current, installs: entries };
            });
        },
        saveDrift: async (drift) => {
            await file.update((current) => ({ ...current, drift }));
        },
        decline: async (tools, at) => {
            if (tools.length === 0) {
                return;
            }
            const names = new Set(tools);
            await file.update((current) => ({
                ...current,
                installs: current.installs.map((entry) => (names.has(entry.tool) ? { ...entry, declinedAt: at } : entry)),
            }));
        },
    };
};
