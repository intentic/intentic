import type { KeyringTypeResult } from "@intentic/sandbox-contract";
import type { DesktopTypist, FocusedDesktopWindow } from "../../desktop/desktop-secret-typing.js";
import type { DevicePointer, KeyringLink } from "../../secrets/device/keyring-link.js";
import { pointerOf } from "../../secrets/device/keyring.testing.js";
import { NO_PROGRAMS, type ProgramGuard } from "../../secrets/guards/program-guards.js";
import type { SecretAccess, SecretTarget, SecretUseReport } from "../../secrets/secret-access.js";
import type { NamedSecret } from "../../secrets/secret-registry.js";
import type { OwnerBrowserTypeArgs, OwnerBrowserTyped, TicketPage } from "../../webext/secret-tickets.js";
import { type KeyringTyping, resolveTypeable, typeInOwnerBrowser, typeOnDesktop, typeOnDevice } from "./secret-typing.js";

/* Where type_secret sends a value besides a sandbox page, with every collaborator faked: what each path asks the gates,
   what it hands the keyring or the typist, what it records, and that no answer carries the value. */

const VALUE = "hunter2-very-secret";

const registry: NamedSecret[] = [
    { name: "VPN_FORTI", value: VALUE, source: "sandbox" },
    { name: "reddit/password", value: "capability-value", source: "capability" },
    { name: "DB_PASSWORD", value: "copied-db-value", source: "copy" },
];

interface Released {
    readonly names: readonly string[];
    readonly lane: string;
    readonly detail: string;
    readonly target: SecretTarget;
}

const fakeSecrets = (refusal?: string) => {
    const released: Released[] = [];
    const used: SecretUseReport[] = [];
    const fetched: { name: string; lane: string; detail: string }[] = [];
    const secrets: SecretAccess = {
        list: async () => registry,
        used: (use) => used.push(use),
        release: async (names, lane, detail, target) => {
            released.push({ names, lane, detail, target });
            return refusal === undefined ? { ok: true, approvedBy: { [names[0] ?? ""]: "owner@example.com" } } : { refusal };
        },
        device: {
            held: async () => [{ name: "SSH_PASS", machine: "omen" }],
            fetch: async (name, lane, detail) => {
                fetched.push({ name, lane, detail });
                return { value: "device-released-value" };
            },
        },
    };
    return { secrets, released, used, fetched };
};

const shared = (name: string, machine: string, over: Partial<DevicePointer["pointer"]> = {}): DevicePointer => ({
    machine,
    pointer: pointerOf(name, over),
    online: true,
    locked: false,
});

const fakeKeyrings = (answer: KeyringTypeResult, guard: ProgramGuard = NO_PROGRAMS, listed: readonly DevicePointer[] = []) => {
    const typed: Parameters<KeyringLink["type"]>[0][] = [];
    const keyrings: KeyringTyping = {
        link: {
            type: async (args) => {
                typed.push(args);
                return answer;
            },
        },
        listed: async () => listed,
        programGuardFor: async () => guard,
    };
    return { keyrings, typed };
};

const TYPED: KeyringTypeResult = { ok: true, program: "FortiClient.exe", field: "password", asked: false };

test("a capability's credential is not typeable, and shadows a keyring entry of the same name", async () => {
    const { secrets } = fakeSecrets();
    const { keyrings } = fakeKeyrings(TYPED, NO_PROGRAMS, [shared("reddit/password", "rog")]);
    expect(await resolveTypeable(secrets, keyrings, "reddit/password")).toBeUndefined();
    expect(await resolveTypeable(secrets, keyrings, "NOPE")).toBeUndefined();
});

test("a keyring copy is typeable with its value in hand and still answers as the keyring's entry", async () => {
    const { secrets } = fakeSecrets();
    const { keyrings } = fakeKeyrings(TYPED, NO_PROGRAMS, [shared("DB_PASSWORD", "omen", { mode: "copy", programs: ["psql.exe"] })]);
    expect(await resolveTypeable(secrets, keyrings, "DB_PASSWORD")).toMatchObject({
        value: "copied-db-value",
        pointer: { machine: "omen" },
        guard: { programs: ["psql.exe"] },
    });
});

test("a sandbox-held value goes sealed to the computer's keyring under the sandbox's own program guard", async () => {
    const { secrets, released, used } = fakeSecrets();
    const { keyrings, typed } = fakeKeyrings(TYPED, { programs: ["FortiClient.exe"], packages: [], anyField: false });
    const secret = await resolveTypeable(secrets, keyrings, "VPN_FORTI");
    if (secret === undefined) {
        throw new Error("VPN_FORTI should resolve");
    }
    const answer = await typeOnDevice(secrets, keyrings, secret, { machine: "rog", why: "connect the VPN", conversationId: "c-1" });
    expect(answer).toEqual({ ok: true, text: "typed {{secret:VPN_FORTI}} into FortiClient.exe's password field on rog (value not shown)" });
    expect(released).toEqual([{ names: ["VPN_FORTI"], lane: "device", detail: "rog", target: { kind: "window", machine: "rog", tool: "mcp__secrets__type_secret" } }]);
    expect(typed).toEqual([
        {
            machine: "rog",
            secret: "VPN_FORTI",
            target: { kind: "window", programs: ["FortiClient.exe"], anyField: false },
            value: VALUE,
            purpose: "agent",
            detail: "connect the VPN",
            conversationId: "c-1",
        },
    ]);
    expect(used).toEqual([{ name: "VPN_FORTI", lane: "device", detail: "rog · FortiClient.exe", approvedBy: "owner@example.com" }]);
});

test("another computer's keyring entry is relayed from there, and the sandbox sends no value", async () => {
    const { secrets } = fakeSecrets();
    const { keyrings, typed } = fakeKeyrings(TYPED, NO_PROGRAMS, [shared("SSH_PASS", "omen", { programs: ["putty.exe"] })]);
    const secret = await resolveTypeable(secrets, keyrings, "SSH_PASS");
    if (secret === undefined) {
        throw new Error("SSH_PASS should resolve");
    }
    await typeOnDevice(secrets, keyrings, secret, { machine: "rog" });
    expect(typed[0]).toMatchObject({ machine: "rog", relayFrom: "omen", target: { kind: "window", programs: ["putty.exe"] } });
    expect(typed[0]).not.toHaveProperty("value");
});

test("a phone app is typed into on the computer it is attached to, under the guard's packages", async () => {
    const { secrets, released } = fakeSecrets();
    const { keyrings, typed } = fakeKeyrings({ ok: true, program: "com.fortinet.forticlient", field: "password", asked: true }, { programs: [], packages: ["com.fortinet.forticlient"], anyField: false });
    const secret = await resolveTypeable(secrets, keyrings, "VPN_FORTI");
    if (secret === undefined) {
        throw new Error("VPN_FORTI should resolve");
    }
    const answer = await typeOnDevice(secrets, keyrings, secret, { machine: "omen", phone: "R58M123" });
    expect(answer.text).toBe("typed {{secret:VPN_FORTI}} into the com.fortinet.forticlient app on the phone attached to omen, after the person there said yes (value not shown)");
    expect(released[0]?.target).toEqual({ kind: "app", machine: "omen", serial: "R58M123", tool: "mcp__secrets__type_secret" });
    expect(typed[0]?.target).toEqual({ kind: "android", serial: "R58M123", packages: ["com.fortinet.forticlient"] });
});

test("a gate's refusal stops the typing before the keyring is asked", async () => {
    const { secrets, used } = fakeSecrets("the owner said no");
    const { keyrings, typed } = fakeKeyrings(TYPED);
    const secret = await resolveTypeable(secrets, keyrings, "VPN_FORTI");
    if (secret === undefined) {
        throw new Error("VPN_FORTI should resolve");
    }
    expect(await typeOnDevice(secrets, keyrings, secret, { machine: "rog" })).toEqual({ ok: false, text: "the owner said no" });
    expect(typed).toEqual([]);
    expect(used).toEqual([]);
});

test("a window the guard does not list says how to add it, and records nothing", async () => {
    const { secrets, used } = fakeSecrets();
    const { keyrings } = fakeKeyrings({ ok: false, code: "guard", refusal: "notepad.exe is not on VPN_FORTI's list." });
    const secret = await resolveTypeable(secrets, keyrings, "VPN_FORTI");
    if (secret === undefined) {
        throw new Error("VPN_FORTI should resolve");
    }
    const answer = await typeOnDevice(secrets, keyrings, secret, { machine: "rog" });
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain("`secrets programs VPN_FORTI add <program.exe>`");
    expect(answer.text).not.toContain(VALUE);
    expect(used).toEqual([]);
});

const fakeTypist = (focused: FocusedDesktopWindow | undefined, outcome: "typed" | "moved" = "typed") => {
    const typed: { window: string; value: string }[] = [];
    const typist: DesktopTypist = {
        focused: async () => focused,
        type: async (window, value) => {
            typed.push({ window, value });
            return outcome;
        },
    };
    return { typist, typed };
};

const XTERM: FocusedDesktopWindow = { window: "4194311", program: "xterm", title: "ssh deploy@db" };

test("on the sandbox's desktop only a listed program takes a value, since nobody is there to ask", async () => {
    const { secrets, released } = fakeSecrets();
    const { keyrings } = fakeKeyrings(TYPED);
    const secret = await resolveTypeable(secrets, keyrings, "VPN_FORTI");
    if (secret === undefined) {
        throw new Error("VPN_FORTI should resolve");
    }
    const { typist, typed } = fakeTypist(XTERM);
    const answer = await typeOnDesktop(secrets, typist, secret);
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain("`secrets programs VPN_FORTI add xterm`");
    expect(released).toEqual([]);
    expect(typed).toEqual([]);
});

test("a listed program on the sandbox's desktop gets the value through the typist, and the use is recorded", async () => {
    const { secrets, released, used } = fakeSecrets();
    const { keyrings } = fakeKeyrings(TYPED, { programs: ["XTerm"], packages: [], anyField: false });
    const secret = await resolveTypeable(secrets, keyrings, "VPN_FORTI");
    if (secret === undefined) {
        throw new Error("VPN_FORTI should resolve");
    }
    const { typist, typed } = fakeTypist(XTERM);
    const answer = await typeOnDesktop(secrets, typist, secret);
    expect(answer).toEqual({ ok: true, text: `typed {{secret:VPN_FORTI}} into xterm's window ("ssh deploy@db") on the sandbox's desktop (value not shown)` });
    expect(released).toEqual([{ names: ["VPN_FORTI"], lane: "desktop", detail: "xterm", target: { kind: "window", machine: "desktop", program: "xterm", tool: "mcp__secrets__type_secret" } }]);
    expect(typed).toEqual([{ window: "4194311", value: VALUE }]);
    expect(used).toEqual([{ name: "VPN_FORTI", lane: "desktop", detail: "xterm", approvedBy: "owner@example.com" }]);
});

test("a keyring entry typed on the sandbox's desktop is released by its computer for that lane", async () => {
    const { secrets, fetched } = fakeSecrets();
    const { keyrings } = fakeKeyrings(TYPED, NO_PROGRAMS, [shared("SSH_PASS", "omen", { programs: ["xterm"] })]);
    const secret = await resolveTypeable(secrets, keyrings, "SSH_PASS");
    if (secret === undefined) {
        throw new Error("SSH_PASS should resolve");
    }
    const { typist, typed } = fakeTypist(XTERM);
    expect((await typeOnDesktop(secrets, typist, secret)).ok).toBe(true);
    expect(fetched).toEqual([{ name: "SSH_PASS", lane: "desktop", detail: "xterm" }]);
    expect(typed).toEqual([{ window: "4194311", value: "device-released-value" }]);
});

test("focus that moved while a card waited types nothing", async () => {
    const { secrets, used } = fakeSecrets();
    const { keyrings } = fakeKeyrings(TYPED, { programs: ["xterm"], packages: [], anyField: false });
    const secret = await resolveTypeable(secrets, keyrings, "VPN_FORTI");
    if (secret === undefined) {
        throw new Error("VPN_FORTI should resolve");
    }
    const { typist } = fakeTypist(XTERM, "moved");
    const answer = await typeOnDesktop(secrets, typist, secret);
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain("the keyboard moved away");
    expect(used).toEqual([]);
});

const fakeTickets = (page: TicketPage) => {
    const answers: unknown[] = [];
    const tickets = {
        typeIn: async (args: OwnerBrowserTypeArgs): Promise<OwnerBrowserTyped> => {
            const answer = await args.redeem(page, new AbortController().signal);
            answers.push(answer);
            return "refusal" in answer ? { ok: false, refusal: answer.refusal } : { ok: true, host: page.host, field: page.field };
        },
    };
    return { tickets, answers };
};

test("the owner's browser takes a value into a password field once the page's host passes the gates", async () => {
    const { secrets, released, used } = fakeSecrets();
    const { keyrings } = fakeKeyrings(TYPED);
    const secret = await resolveTypeable(secrets, keyrings, "VPN_FORTI");
    if (secret === undefined) {
        throw new Error("VPN_FORTI should resolve");
    }
    const { tickets, answers } = fakeTickets({ url: "https://vpn.example.com/login", host: "vpn.example.com", field: "password" });
    const answer = await typeInOwnerBrowser(secrets, tickets, secret, "chrome");
    expect(answer).toEqual({ ok: true, text: "typed {{secret:VPN_FORTI}} into the focused password field on vpn.example.com in the owner's browser (value not shown)" });
    expect(released[0]).toEqual({
        names: ["VPN_FORTI"],
        lane: "browser",
        detail: "vpn.example.com",
        target: { kind: "page", url: "https://vpn.example.com/login", tool: "mcp__secrets__type_secret" },
    });
    expect(answers).toEqual([{ value: VALUE }]);
    expect(used).toEqual([{ name: "VPN_FORTI", lane: "browser", detail: "vpn.example.com", approvedBy: "owner@example.com" }]);
});

test("a field the owner's browser does not mark as a password field is refused unless the guard allows any field", async () => {
    const { secrets, released } = fakeSecrets();
    const { keyrings } = fakeKeyrings(TYPED);
    const secret = await resolveTypeable(secrets, keyrings, "VPN_FORTI");
    if (secret === undefined) {
        throw new Error("VPN_FORTI should resolve");
    }
    const { tickets } = fakeTickets({ url: "https://evil.example/", host: "evil.example", field: "text" });
    const answer = await typeInOwnerBrowser(secrets, tickets, secret, "chrome");
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain("`secrets programs VPN_FORTI any-field on`");
    expect(released).toEqual([]);
});
