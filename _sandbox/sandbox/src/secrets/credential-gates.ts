import { readFile } from "node:fs/promises";
import { type CredentialGate, type CredentialGateKind, CredentialGatesSchema } from "@intentic/sandbox-contract";
import { writeJsonFile } from "../store/json-file.js";

// Which credentials need a named person's click, stored off the workspace beside the vault (mode 0600), since
// `.intentic/config/` is agent-editable and would let a turn edit its own lock. Read throws on an unreadable file
// rather than falling back, since empty here means nothing is gated. A subject is a whole capability account, never one
// vault field.

export interface CredentialGatesStore {
    // Every gate in force; `[]` if never written, throws if the file exists but cannot be read or parsed.
    readonly list: () => Promise<readonly CredentialGate[]>;
    // Upserts by subject: re-gating replaces approvers and scope rather than stacking a second gate.
    readonly set: (gate: CredentialGate) => Promise<void>;
    readonly remove: (subject: string) => Promise<void>;
    // The gate covering one registry name (`DATABASE_URL`, `reddit/password`), by the subject rule below.
    readonly forName: (name: string) => Promise<CredentialGate | undefined>;
    readonly forCapability: (id: string) => Promise<CredentialGate | undefined>;
}

// A name with a `/` is a capability vault entry (`<capabilityId>/<field>`) and answers to its capability; anything else
// answers to itself. Env keys are SCREAMING_SNAKE and capability ids are not, so the slash alone disambiguates.
export const gateSubjectOf = (name: string): string => {
    const slash = name.indexOf("/");
    return slash === -1 ? name : name.slice(0, slash);
};

// Subject and kind together, so callers don't re-derive the slash rule themselves: `reddit/password` asks about the
// capability `reddit`, `DATABASE_URL` asks about the secret of that name.
export const gateTargetOf = (name: string): { readonly subject: string; readonly kind: CredentialGateKind } =>
    name.includes("/") ? { subject: gateSubjectOf(name), kind: "capability" } : { subject: name, kind: "secret" };

// The gate for a name, over a list already in hand; matches kind as well as subject, so a capability cannot answer for
// a same-named env key.
export const gateForName = (gates: readonly CredentialGate[], name: string): CredentialGate | undefined => {
    const { subject, kind } = gateTargetOf(name);
    return gates.find((gate) => gate.kind === kind && gate.subject === subject);
};

export const gateForCapability = (gates: readonly CredentialGate[], id: string): CredentialGate | undefined =>
    gates.find((gate) => gate.kind === "capability" && gate.subject === id);

export const fileCredentialGates = (path: string): CredentialGatesStore => {
    // Serializes read-modify-write writes into one chain, so a second write can't clobber one still in flight.
    let queue: Promise<unknown> = Promise.resolve();
    const list = async (): Promise<readonly CredentialGate[]> => {
        let text: string;
        try {
            text = await readFile(path, "utf8");
        } catch (error) {
            // ENOENT is the ordinary first state; anything else is unreadable, and must not be read as absent.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return [];
            }
            throw new Error(`the credential gate policy at ${path} could not be read`, { cause: error });
        }
        // Catches JSON.parse too: unparseable JSON and JSON that isn't a policy report the same refusal.
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            throw new Error(`the credential gate policy at ${path} could not be read`);
        }
        const parsed = CredentialGatesSchema.safeParse(raw);
        if (!parsed.success) {
            throw new Error(`the credential gate policy at ${path} is not readable as a policy`);
        }
        return parsed.data.gates;
    };
    const write = async (change: (current: readonly CredentialGate[]) => readonly CredentialGate[]): Promise<void> => {
        const run = queue.then(async () => {
            const next = change(await list());
            await writeJsonFile(path, { gates: next }, 0o600);
        });
        // Catches so a failed write doesn't break the chain; the next edit still queues behind this one.
        queue = run.catch(() => undefined);
        await run;
    };
    return {
        list,
        set: (gate) => write((current) => [...current.filter((entry) => entry.subject !== gate.subject), gate]),
        remove: (subject) => write((current) => current.filter((entry) => entry.subject !== subject)),
        forName: async (name) => gateForName(await list(), name),
        forCapability: async (id) => gateForCapability(await list(), id),
    };
};
