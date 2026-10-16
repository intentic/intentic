import { hasSecretReferences, type NamedSecret, referencedNames, resolveSecretReferences } from "./secret-registry.js";
import { DETAIL_MAX } from "./secret-uses.js";

// The only place a `{{secret:name}}` reference becomes its real value, after the permission card and command gate have
// already seen the reference-form line. Not wired into Edit/Write: a file at rest keeps the reference, never the value.
// An unknown name is a hard refusal; substitution is textual, inside whatever quoting the agent chose.

// The exits a value leaves through: a command, a script, a page in a sandbox browser, a window or phone app on one of
// the owner's computers, a window on the sandbox's own desktop.
export type SecretLane = "shell" | "code" | "browser" | "device" | "desktop";

export interface SecretUseReport {
    readonly name: string;
    readonly lane: SecretLane;
    readonly detail?: string;
    // Who released it, for a name behind a named approver; absent on the ordinary ungated use.
    readonly approvedBy?: string;
}

// Where the values are about to go, for the host limit (host-guard-gate.ts): the reference-form program of a command or
// script, the page a value is typed into, or a window or phone app on one of the owner's computers, each with the tool
// a card about it files under. A window and an app name no site, so a host-guarded secret typed into one asks.
export type SecretTarget =
    | { readonly kind: "program"; readonly text: string; readonly language: "bash" | "javascript"; readonly tool: string }
    | { readonly kind: "page"; readonly url: string; readonly tool: string }
    | { readonly kind: "window"; readonly machine: string; readonly program?: string; readonly tool: string }
    | { readonly kind: "app"; readonly machine: string; readonly serial: string; readonly tool: string };

// Secrets a keyring on one of the owner's computers holds (secrets/device/): this sandbox knows their names and holds
// none of their values, so each use asks that computer for one, after every gate here has had its say.
export interface DeviceSecrets {
    // The names a reference may carry that only a computer's keyring answers to: no sandbox store holds one of them.
    readonly held: () => Promise<readonly { readonly name: string; readonly machine: string }[]>;
    // One value for one use, asked of the computer now. Never answered from anything kept: a value a computer released
    // before is kept only to mask, and a second use is a second question to the person at that computer.
    readonly fetch: (name: string, lane: "shell" | "code" | "browser" | "desktop", detail: string) => Promise<{ readonly value: string } | { readonly refusal: string }>;
}

// `used` is fire-and-forget; `release` decides whether the exit happens, and takes the whole list so the owner is asked
// once per credential (names sharing a subject), not once per token. `device` is absent where no keyring can be reached
// (a test, a runtime with no daemon behind it): a device-held name is then as unknown as any other.
export interface SecretAccess {
    readonly list: () => Promise<readonly NamedSecret[]>;
    readonly used: (use: SecretUseReport) => void;
    readonly release: (
        names: readonly string[],
        lane: SecretLane,
        detail: string,
        target: SecretTarget,
    ) => Promise<{ readonly ok: true; readonly approvedBy?: Readonly<Record<string, string>> } | { readonly refusal: string }>;
    readonly device?: DeviceSecrets;
}

// The audit row's "used where", from the agent's own reference-form command line; one head, not the whole line, avoids
// archiving shell history twice.
const commandDetail = (command: string): string => {
    const head = command.trim().replaceAll(/\s+/g, " ");
    return head.length <= DETAIL_MAX ? head : `${head.slice(0, DETAIL_MAX)}…`;
};

export type ResolvedCommand = { readonly command: string } | { readonly refusal: string };

// The way to get a name nobody holds is part of the refusal: a card the person pastes the value into, never the chat,
// so the agent neither stops to write instructions nor asks for a value it would then hold (docs/architecture/needs.md).
const unknownRefusal = (unknown: readonly string[], known: readonly string[]): ResolvedCommand => {
    const ask = unknown.map((name) => `\`secrets ask ${name} --why "…"\``).join(" or ");
    return {
        refusal: `no stored secret named ${unknown.map((name) => `"${name}"`).join(", ")}: ${
            known.length === 0 ? "nothing is stored yet" : `stored names: ${known.join(", ")}`
        }. If it is a different name above, use that; if the task needs one nobody has stored, ask for it with ${ask}, which puts a card with a masked field in front of the owner and answers once it is stored.`,
    };
};

// What a reference may resolve from: every value a sandbox store holds, and the names a computer's keyring answers to.
// A value the registry lists as released by a computer is never one of them: it is there to mask, and reusing it would
// spend a person's yes twice.
interface Holdings {
    readonly held: readonly NamedSecret[];
    readonly onDevice: ReadonlySet<string>;
}

const holdingsOf = async (secrets: SecretAccess): Promise<Holdings | undefined> => {
    let registry: readonly NamedSecret[];
    let device: readonly { readonly name: string }[];
    try {
        [registry, device] = await Promise.all([secrets.list(), secrets.device?.held() ?? []]);
    } catch {
        // allow(silent-catch): an unreadable store refuses the whole resolution with its own sentence, never passes a token on.
        return undefined;
    }
    const held = registry.filter((secret) => secret.source !== "device");
    const names = new Set(held.map((secret) => secret.name));
    // A name a sandbox store holds resolves from there: the store wins over a computer's keyring of the same name.
    return { held, onDevice: new Set(device.map((entry) => entry.name).filter((name) => !names.has(name))) };
};

// Each device-held value, asked of its computer once every gate let the use go; the first refusal is the command's.
const fetchDeviceValues = async (
    device: DeviceSecrets,
    names: readonly string[],
    lane: "shell" | "code",
    detail: string,
): Promise<{ readonly values: readonly NamedSecret[] } | { readonly refusal: string }> => {
    const values: NamedSecret[] = [];
    for (const name of names) {
        const fetched = await device.fetch(name, lane, detail);
        if ("refusal" in fetched) {
            return fetched;
        }
        values.push({ name, value: fetched.value, source: "device" });
    }
    return { values };
};

// Skips the registry read when the command has no reference at all. An unreadable registry refuses rather than passing
// the token through. In this order, so nothing is asked of anybody for a use that cannot happen and no value exists
// before the gates said yes: every name known, then the gates (named approvers, the host guard), then each value a
// computer's keyring holds, then the substitution. `lane` and `tool` exist because the JS execution backend is a second
// caller, resolving into its own subprocess.
export const resolveCommandSecrets = async (
    command: string,
    secrets: SecretAccess,
    lane: "shell" | "code" = "shell",
    tool = "Bash",
): Promise<ResolvedCommand> => {
    if (!hasSecretReferences(command)) {
        return { command };
    }
    const holdings = await holdingsOf(secrets);
    if (holdings === undefined) {
        return { refusal: "the secret store could not be read, the reference cannot be resolved; retry, or run the command without it" };
    }
    const names = referencedNames(command);
    const known = new Set([...holdings.held.map((secret) => secret.name), ...holdings.onDevice]);
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length > 0) {
        return unknownRefusal(unknown, [...known]);
    }
    // After the all-names-known check: a command with one gated and one nonexistent name shouldn't spend anyone's
    // attention. Before the audit rows: a refused resolution never left, so recording it would corrupt last-used.
    const detail = commandDetail(command);
    const released = await secrets.release(names, lane, detail, {
        kind: "program",
        text: command,
        language: lane === "shell" ? "bash" : "javascript",
        tool,
    });
    if ("refusal" in released) {
        return { refusal: released.refusal };
    }
    const onDevice = names.filter((name) => holdings.onDevice.has(name));
    let fetched: readonly NamedSecret[] = [];
    if (onDevice.length > 0 && secrets.device !== undefined) {
        const asked = await fetchDeviceValues(secrets.device, onDevice, lane, detail);
        if ("refusal" in asked) {
            return asked;
        }
        fetched = asked.values;
    }
    const { text } = resolveSecretReferences(command, [...holdings.held, ...fetched]);
    for (const name of names) {
        const approvedBy = released.approvedBy?.[name];
        secrets.used({ name, lane, detail, ...(approvedBy !== undefined ? { approvedBy } : {}) });
    }
    return { command: text };
};
