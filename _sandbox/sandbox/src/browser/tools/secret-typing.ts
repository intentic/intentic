import type { KeyringTypeResult } from "@intentic/sandbox-contract";
import { opt } from "../../opt.js";
import type { DesktopTypist } from "../../desktop/desktop-secret-typing.js";
import { keyringNextStep, sandboxHeld } from "../../secrets/device/device-secrets.js";
import type { DevicePointer, KeyringLink } from "../../secrets/device/keyring-link.js";
import type { ProgramGuard } from "../../secrets/guards/program-guards.js";
import type { SecretAccess } from "../../secrets/secret-access.js";
import { type NamedSecret, secretReference } from "../../secrets/secret-registry.js";
import type { SecretTickets } from "../../webext/secret-tickets.js";

// Where `type_secret` (secrets-tools.ts) sends a value besides a sandbox browser's page: the window that has the
// keyboard on one of the owner's computers, an app on a phone attached to one, a window on the sandbox's own desktop, and
// a page in the owner's own browser. The agent names the place and the secret; the value goes there without passing
// through anything the agent reads, and what comes back is only where it went.
//
// A value the sandbox holds goes sealed to the keyring on that computer, which checks the window and types it; one a
// keyring holds is typed by that keyring, or sealed by the computer that holds it straight to the one typing. The
// sandbox's desktop and the owner's browser have no keyring of their own, so the daemon releases the value there, after
// the same gates as a command's.

export const TYPE_SECRET_TOOL = "mcp__secrets__type_secret";

// A secret as typing sees it: a value the sandbox holds now, a keyring's entry, or both (a copy, kept here and still the
// keyring's), with the program guard that applies to it.
export interface TypeableSecret {
    readonly name: string;
    // In hand: the sandbox's own stores, or a keyring's copy. Absent for an entry only its keyring holds.
    readonly value?: string;
    // The keyring entry it is, when it is one; its own lists are the guard.
    readonly pointer?: DevicePointer;
    readonly guard: ProgramGuard;
}

// Only user-kept kinds: a capability's own credential has its own lanes (type_credential, env vars).
const USER_KEPT: ReadonlySet<NamedSecret["source"]> = new Set(["env", "sandbox", "generated"]);

export const typeableSecret = (registry: readonly NamedSecret[], name: string): NamedSecret | undefined =>
    registry.find((secret) => secret.name === name && USER_KEPT.has(secret.source));

export interface KeyringTyping {
    readonly link: Pick<KeyringLink, "type">;
    // The keyring entries this sandbox lists: shared ones and copies, none a sandbox store answers to.
    readonly listed: () => Promise<readonly DevicePointer[]>;
    readonly programGuardFor: (name: string) => Promise<ProgramGuard>;
}

const pointerGuard = (pointer: DevicePointer): ProgramGuard => ({
    programs: [...pointer.pointer.programs],
    packages: [...pointer.pointer.packages],
    anyField: pointer.pointer.anyField,
});

// The secret by that name, or undefined when nothing typeable answers to it.
export const resolveTypeable = async (secrets: Pick<SecretAccess, "list">, keyrings: KeyringTyping | undefined, name: string): Promise<TypeableSecret | undefined> => {
    const registry = await secrets.list();
    const own = typeableSecret(registry, name);
    if (own !== undefined) {
        return { name, value: own.value, guard: keyrings === undefined ? { programs: [], packages: [], anyField: false } : await keyrings.programGuardFor(name) };
    }
    // A capability's credential under this name is not typeable, and shadows any keyring entry of the same name.
    if (keyrings === undefined || registry.some((secret) => secret.name === name && sandboxHeld(secret))) {
        return undefined;
    }
    const pointer = (await keyrings.listed()).find((entry) => entry.pointer.name === name);
    if (pointer === undefined) {
        return undefined;
    }
    const copy = registry.find((secret) => secret.name === name && secret.source === "copy");
    return { name, ...opt("value", copy?.value), pointer, guard: pointerGuard(pointer) };
};

export const notTypeable = (name: string): string =>
    `no typeable secret named "${name}": the name is what ${secretReference("…")} masking shows, and only user-kept secrets (the Secrets view's own ` +
    `entries, and those a keyring on the owner's computers shares here) can be typed. If it does not exist yet, ask for it with \`secrets ask ${name} --why "…"\`: ` +
    "the owner pastes it into a card, or keeps it on their computer, and it can be typed from then on";

// The value for a use in a lane that types it from the sandbox (a page, the sandbox's desktop): the one in hand, or one
// released now by the keyring that holds it. Called only after the gates said yes.
export const valueForUse = async (
    secrets: Pick<SecretAccess, "device">,
    secret: TypeableSecret,
    lane: "browser" | "desktop",
    detail: string,
): Promise<{ readonly value: string } | { readonly refusal: string }> => {
    if (secret.value !== undefined) {
        return { value: secret.value };
    }
    if (secrets.device === undefined) {
        return { refusal: `"${secret.name}" is kept in a keyring on the owner's computers, which this turn cannot reach.` };
    }
    return secrets.device.fetch(secret.name, lane, detail);
};

// ---- a computer's window, or a phone app on it ----

export interface DeviceTypeRequest {
    readonly machine: string;
    // An adb serial: an app on a phone attached to `machine` instead of its focused window.
    readonly phone?: string;
    // What the person asked at that computer reads: the agent's own words for what it is for.
    readonly why?: string;
    readonly conversationId?: string;
    readonly signal?: AbortSignal;
}

const fieldWords = (field: "password" | "text"): string => (field === "password" ? "password field" : "text field");

// What a guard refusal leaves to do: the sandbox's own list is changed here, with the owner's yes; a keyring's on that
// computer, by the person there.
const guardNextStep = (secret: TypeableSecret, phone: boolean): string => {
    if (secret.pointer !== undefined) {
        return `Where "${secret.name}" may go is the keyring's own list on ${secret.pointer.machine}: the owner changes it there. Do not retry into the same place.`;
    }
    return phone
        ? `To let it go into that app, \`secrets programs ${secret.name} --package add <package>\` asks the owner. Do not retry into the same app before that.`
        : `To let it go into that program, \`secrets programs ${secret.name} add <program.exe>\` asks the owner (and \`any-field on\` for a field not marked as a password field). Do not retry into the same window before that.`;
};

const typedWords = (secret: TypeableSecret, request: DeviceTypeRequest, typed: Extract<KeyringTypeResult, { ok: true }>): string => {
    const place = request.phone === undefined ? `${typed.program}'s ${fieldWords(typed.field)} on ${request.machine}` : `the ${typed.program} app on the phone attached to ${request.machine}`;
    const asked = typed.asked ? ", after the person there said yes" : "";
    return `typed ${secretReference(secret.name)} into ${place}${asked} (value not shown)`;
};

// Types into the focused window (or phone app) on one of the owner's computers through its keyring, after the sandbox's
// own gates: the host guard (a window names no site, so a host-limited secret asks), and a named approver.
export const typeOnDevice = async (
    secrets: Pick<SecretAccess, "release" | "used">,
    keyrings: KeyringTyping,
    secret: TypeableSecret,
    request: DeviceTypeRequest,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string }> => {
    const { machine, phone } = request;
    const detail = (request.why ?? "").trim() === "" ? `the agent's type_secret into the focused ${phone === undefined ? "window" : "app"}` : (request.why ?? "").trim();
    const released = await secrets.release(
        [secret.name],
        "device",
        `${machine}${phone === undefined ? "" : ` · ${phone}`}`,
        phone === undefined ? { kind: "window", machine, tool: TYPE_SECRET_TOOL } : { kind: "app", machine, serial: phone, tool: TYPE_SECRET_TOOL },
    );
    if ("refusal" in released) {
        return { ok: false, text: released.refusal };
    }
    const target =
        phone === undefined
            ? { kind: "window" as const, programs: [...secret.guard.programs], anyField: secret.guard.anyField }
            : { kind: "android" as const, serial: phone, packages: [...secret.guard.packages] };
    // A value the sandbox holds goes sealed with its own guard; a keyring entry is the keyring's, typed by it or relayed
    // from the computer that holds it (a copy too: the keyring's entry, not the copy kept here, is what is typed).
    const sandboxValue = secret.pointer === undefined ? secret.value : undefined;
    const relayFrom = secret.pointer === undefined || secret.pointer.machine === machine ? undefined : secret.pointer.machine;
    const typed = await keyrings.link.type({
        machine,
        secret: secret.name,
        target,
        ...opt("value", sandboxValue),
        ...opt("relayFrom", relayFrom),
        purpose: "agent",
        detail,
        ...opt("conversationId", request.conversationId),
        ...opt("signal", request.signal),
    });
    if (!typed.ok) {
        const next =
            typed.code === "guard"
                ? guardNextStep(secret, phone !== undefined)
                : typed.code === "unavailable"
                  ? `${keyringNextStep(typed.code)} A computer with no keyring yet needs \`intentic-machine keyring setup\` run there by the owner.`
                  : keyringNextStep(typed.code);
        return { ok: false, text: `nothing was typed: ${typed.refusal} ${next}` };
    }
    const approvedBy = released.approvedBy?.[secret.name];
    secrets.used({ name: secret.name, lane: "device", detail: `${machine} · ${typed.program}`, ...opt("approvedBy", approvedBy) });
    return { ok: true, text: typedWords(secret, request, typed) };
};

// ---- the sandbox's own desktop ----

const onList = (programs: readonly string[], program: string): boolean => programs.some((listed) => listed.toLowerCase() === program.toLowerCase());

// Types into the window with the keyboard on the sandbox's desktop. No person sits at that screen to ask, and X11 does
// not say whether a field is a password field, so the program must be on the secret's list: nothing else lets it go.
export const typeOnDesktop = async (
    secrets: Pick<SecretAccess, "release" | "used" | "device">,
    typist: DesktopTypist,
    secret: TypeableSecret,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string }> => {
    const focused = await typist.focused();
    if (focused === undefined) {
        return { ok: false, text: "no window has the keyboard on the sandbox's desktop: click into the field with the desktop tools first, then call this again" };
    }
    if (!onList(secret.guard.programs, focused.program)) {
        const where =
            secret.pointer === undefined
                ? `\`secrets programs ${secret.name} add ${focused.program}\` asks the owner to put it on the list`
                : `the keyring on ${secret.pointer.machine} keeps that list, and the owner changes it there`;
        return {
            ok: false,
            text:
                `nothing was typed: ${focused.program} is not on ${secret.name}'s list of programs it may be typed into, and on the sandbox's desktop ` +
                `nobody is at the screen to ask and field kinds cannot be read, so only a listed program takes it. ${where}.`,
        };
    }
    const released = await secrets.release([secret.name], "desktop", focused.program, { kind: "window", machine: "desktop", program: focused.program, tool: TYPE_SECRET_TOOL });
    if ("refusal" in released) {
        return { ok: false, text: released.refusal };
    }
    const value = await valueForUse(secrets, secret, "desktop", focused.program);
    if ("refusal" in value) {
        return { ok: false, text: value.refusal };
    }
    if ((await typist.type(focused.window, value.value)) === "moved") {
        return { ok: false, text: `nothing was typed: the keyboard moved away from ${focused.program}'s window while this waited. Click back into the field and call this again.` };
    }
    secrets.used({ name: secret.name, lane: "desktop", detail: focused.program, ...opt("approvedBy", released.approvedBy?.[secret.name]) });
    const title = focused.title === "" ? "" : ` ("${focused.title.slice(0, 80)}")`;
    return { ok: true, text: `typed ${secretReference(secret.name)} into ${focused.program}'s window${title} on the sandbox's desktop (value not shown)` };
};

// ---- the owner's own browser ----

// Types into the focused field of the active tab in the owner's browser, through its extension: the daemon mints a
// one-time ticket, the extension redeems it with the page it is about to type into, and only then do the gates run and
// the value go, to that extension alone. A field not marked as a password field takes it only where the guard says so,
// since the extension's own snapshot reads such a field's value back.
export const typeInOwnerBrowser = async (
    secrets: Pick<SecretAccess, "release" | "used" | "device">,
    tickets: Pick<SecretTickets, "typeIn">,
    secret: TypeableSecret,
    card: string,
    signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string }> => {
    let approvedBy: string | undefined;
    const typed = await tickets.typeIn({
        card,
        secret: secret.name,
        ...opt("signal", signal),
        redeem: async (page) => {
            if (page.field === "text" && !secret.guard.anyField) {
                return {
                    refusal:
                        `the focused field on ${page.host} is not a password field, and ${secret.name} goes only into password fields there${ 
                        secret.pointer === undefined
                            ? `: \`secrets programs ${secret.name} any-field on\` asks the owner to allow any field`
                            : `: the keyring on ${secret.pointer.machine} keeps that rule`}`,
                };
            }
            const released = await secrets.release([secret.name], "browser", page.host, { kind: "page", url: page.url, tool: TYPE_SECRET_TOOL });
            if ("refusal" in released) {
                return released;
            }
            approvedBy = released.approvedBy?.[secret.name];
            return valueForUse(secrets, secret, "browser", page.host);
        },
    });
    if (!typed.ok) {
        return { ok: false, text: `nothing was typed: ${typed.refusal}` };
    }
    secrets.used({ name: secret.name, lane: "browser", detail: typed.host, ...opt("approvedBy", approvedBy) });
    return { ok: true, text: `typed ${secretReference(secret.name)} into the focused ${fieldWords(typed.field)} on ${typed.host} in the owner's browser (value not shown)` };
};
