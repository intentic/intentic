import { errorMessage } from "@intentic/base/errors";
import { type StackRegistryLogin, StackRegistryLoginSchema } from "@intentic/sandbox-contract/schemas/device-stacks";
import type { CredentialGate } from "@intentic/sandbox-contract/schemas/secrets";
import { gateForName } from "../../secrets/credential-gates.js";
import { secretReference, surfaceForms } from "../../secrets/secret-registry.js";

// A MANAGED STACK'S `.env` AND REGISTRY LOGINS, FILLED BY THE DAEMON (schemas/device-stacks.ts
// DeviceStackManagedDeployInputSchema): the Deployments extension sends them with `{{secret:NAME}}` references, and only
// this sandbox's own secret store fills them, never an agent turn or the extension. A deploy runs with nobody watching,
// so every way a value could need a person, or come from somewhere the owner did not hand this stack, refuses instead,
// in a sentence naming the secret and what to do about it, never its value:
//   - a name behind a named approver (credential gates): there is nobody to approve an unattended deploy;
//   - a name this sandbox's store does not hold, or holds only in a connection's vault or a computer's keyring, which
//     answer a person's use rather than a server's.
// Whether the owner granted the stack each name is checked before this (managed-deploy.ts, secrets/stack-grants/stack-grants.ts).
// Filling is one pass over the text: a value is never read again for references, so a secret holding `{{secret:OTHER}}`
// arrives exactly as stored, and any other `{{…}}` (the extension's own, which it fills first) is left as it is.
// (2026-11-25) Moved here from the daemon's own deploy engine, which also filled `{{deploy:…}}` facts: those are the
// extension's now.

// What the daemon renders: the stack's variables and its registry logins.
export interface ManagedSpec {
    readonly env: Readonly<Record<string, string>>;
    readonly registries: readonly StackRegistryLogin[];
}

// Where values come from, and what the refusals need to know about the rest.
export interface RenderSources {
    // The sandbox's own store: the only place a deploy takes a value from.
    readonly own: (name: string) => Promise<string | undefined>;
    // What else holds a name, in words ("a connection's vault", "the keyring on rog"), when this store does not.
    readonly heldElsewhere: (name: string) => Promise<string | undefined>;
    readonly gates: () => Promise<readonly CredentialGate[]>;
}

export type Rendered =
    | {
          readonly ok: true;
          // The whole `.env`, or undefined when the stack sends no variables (a `.env` already there is then left alone).
          readonly env: string | undefined;
          readonly registries: readonly StackRegistryLogin[];
          readonly secretNames: readonly string[];
          // Each secret's value, by name, for its mark and the masking of what the machine printed back (maskedText);
          // never stored, never answered.
          readonly values: ReadonlyMap<string, string>;
      }
    | { readonly ok: false; readonly error: string; readonly secretNames: readonly string[] };

// One reference, in one pass: its name, and whether it asked for a file.
const REFERENCE = /\{\{secret:([A-Za-z0-9_./-]+)(\|file)?\}\}/g;

// The secret names a stack reads: in its variables' values and its registries' passwords (and, refused below, anywhere
// else in a login). Sorted, once each: what its grant must cover.
export const secretNamesOf = (spec: ManagedSpec): string[] => {
    const names = new Set<string>();
    const texts = [...Object.values(spec.env), ...spec.registries.flatMap((registry) => [registry.host, registry.username, registry.password])];
    for (const text of texts) {
        for (const match of text.matchAll(REFERENCE)) {
            names.add(match[1] ?? "");
        }
    }
    names.delete("");
    return [...names].toSorted();
};

// What compose's dotenv reads unquoted as itself: no space, quote, `#`, `$` or backslash.
const PLAIN = /^[A-Za-z0-9_./:@%+,=-]*$/;

// A value as one dotenv line's right-hand side that compose (compose-go's dotenv, Compose v2) reads back exactly, or
// undefined for the one value it cannot hold. Single quotes are literal there, lines included, with no escapes and no
// `$` interpolation, so they carry almost everything; a value with a `'` (or a carriage return, which the reader folds)
// goes in double quotes, where `\\`, `\"`, `\n` and `\r` are escapes and `$$` is a literal `$`. Neither form can end
// in a backslash: the reader takes the closing quote after one as escaped and runs on past the value.
export const dotenvValue = (value: string): string | undefined => {
    if (PLAIN.test(value)) {
        return value;
    }
    if (value.includes("\0") || value.endsWith("\\")) {
        return undefined;
    }
    if (!value.includes("'") && !value.includes("\r")) {
        return `'${value}'`;
    }
    const escaped = value
        .replace(/\\/g, () => "\\\\")
        .replace(/"/g, () => '\\"')
        .replace(/\n/g, () => "\\n")
        .replace(/\r/g, () => "\\r")
        .replace(/\$/g, () => "$$");
    return `"${escaped}"`;
};

// "A", "A and B", "A, B and C", each quoted.
export const listedNames = (names: readonly string[]): string => {
    const quoted = names.map((name) => `"${name}"`);
    return quoted.length <= 1 ? (quoted[0] ?? "") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1) ?? ""}`;
};
const isAre = (names: readonly string[]): string => (names.length === 1 ? "is" : "are");

// Every way the stack's names cannot be filled, each a sentence; empty when every one can.
const refusalsOf = async (names: readonly string[], sources: RenderSources): Promise<string[]> => {
    let gates: readonly CredentialGate[];
    try {
        gates = await sources.gates();
    } catch (error) {
        // Unreadable must never read as "nothing gated".
        return [`The credential gates could not be read (${errorMessage(error)}): nothing is filled until they can.`];
    }
    const refusals: string[] = [];
    const gated = names.filter((name) => gateForName(gates, name) !== undefined);
    if (gated.length > 0) {
        refusals.push(
            `${listedNames(gated)} ${isAre(gated)} behind a named approver, and a deploy runs with nobody there to approve it: take the gate off in Secrets, or give the stack a secret of its own.`,
        );
    }
    for (const name of names) {
        if ((await sources.own(name)) !== undefined) {
            continue;
        }
        const elsewhere = await sources.heldElsewhere(name);
        refusals.push(
            elsewhere === undefined
                ? `No secret named "${name}" is stored in this sandbox: store it (\`secrets ask ${name}\`, or \`secrets import ${name} --stdin\`), then deploy again.`
                : `"${name}" is held only by ${elsewhere}, and a deploy fills from this sandbox's own secret store alone: store a copy here (\`secrets import ${name} --stdin\`), then deploy again.`,
        );
    }
    return refusals;
};

// The text with every reference filled in, in one pass. `secrets` holds every name the text may read, checked already.
const filled = (text: string, secrets: ReadonlyMap<string, string>): string => text.replace(REFERENCE, (token, name: string) => secrets.get(name) ?? token);

// A reference to a file (`{{secret:NAME|file}}`) has no file to become on the computer, and a secret written where the
// grant cannot see it (a registry's host or user name) would reach the stack in the clear: both refused by where they are.
const misplaced = (spec: ManagedSpec): string[] => {
    const refusals: string[] = [];
    for (const [key, value] of Object.entries(spec.env)) {
        for (const match of value.matchAll(REFERENCE)) {
            if (match[2] !== undefined) {
                const name = match[1] ?? "";
                refusals.push(`${key} reads {{secret:${name}|file}}, and a stack's .env has no file to point at: write {{secret:${name}}}, and its value is quoted into the .env with its lines.`);
            }
        }
    }
    for (const registry of spec.registries) {
        if (/\{\{secret:/.test(registry.host) || /\{\{secret:/.test(registry.username)) {
            refusals.push(`The login for ${registry.host} names a secret outside its password: only a registry's password reads one.`);
        }
        if (/\{\{secret:[^}]*\|file\}\}/.test(registry.password)) {
            refusals.push(`The login for ${registry.host} reads its password as a file, which a registry login cannot take: write {{secret:NAME}}.`);
        }
    }
    return refusals;
};

// The stack's `.env` and registry logins, or the refusal.
export const renderManaged = async (spec: ManagedSpec, sources: RenderSources): Promise<Rendered> => {
    const secretNames = secretNamesOf(spec);
    const refusals = [...misplaced(spec), ...(await refusalsOf(secretNames, sources))];
    if (refusals.length > 0) {
        return { ok: false, error: refusals.join(" "), secretNames };
    }
    const values = new Map<string, string>();
    for (const name of secretNames) {
        values.set(name, (await sources.own(name)) ?? "");
    }
    const lines: string[] = [];
    for (const [key, raw] of Object.entries(spec.env)) {
        const value = dotenvValue(filled(raw, values));
        if (value === undefined) {
            return {
                ok: false,
                error: `${key}'s value ends in a backslash or holds a NUL character, which a .env cannot carry: change the value or how the stack reads it.`,
                secretNames,
            };
        }
        lines.push(`${key}=${value}`);
    }
    const registries: StackRegistryLogin[] = [];
    for (const registry of spec.registries) {
        const login = StackRegistryLoginSchema.safeParse({ ...registry, password: filled(registry.password, values) });
        if (!login.success) {
            // Named by field, never by what the field held: the password is one of them.
            const fields = [...new Set(login.error.issues.map((issue) => String(issue.path[0] ?? "login")))];
            return { ok: false, error: `The login for ${registry.host}, filled, is not one a registry takes (${fields.join(", ")}).`, secretNames };
        }
        registries.push(login.data);
    }
    return { ok: true, env: lines.length === 0 ? undefined : `${lines.join("\n")}\n`, registries, secretNames, values };
};

// The shortest value masked in what the machine printed back: shorter ones would mangle the text more than they hide.
const MASKED_MIN = 4;

// What a hook or compose printed, with every value this deploy filled put back as its reference, in each form a reader
// may see it (raw, JSON-escaped, percent-encoded): a hook that echoes its environment must not put a secret into the
// answer, which the extension keeps in its deploy records where agents read.
export const maskedText = (text: string, values: ReadonlyMap<string, string>): string => {
    let masked = text;
    const longestFirst = [...values.entries()].filter(([, value]) => value.length >= MASKED_MIN).toSorted(([, left], [, right]) => right.length - left.length);
    for (const [name, value] of longestFirst) {
        for (const form of surfaceForms(value)) {
            masked = masked.split(form).join(secretReference(name));
        }
    }
    return masked;
};
