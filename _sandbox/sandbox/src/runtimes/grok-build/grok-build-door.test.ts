import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { grokDoors } from "./grok-build-door.js";

/* Grok's one door over two sign-ins: a start, a row, a rename and a disconnect each reach the half that holds them. */

const door = (name: string, rows: OauthAccount[], calls: string[]): AccountDoor => ({
    start: async (variant) => {
        calls.push(`${name}.start:${variant ?? ""}`);
        return { url: name, code: "", state: "", flow: "device", variant: variant ?? "", handshake: name, expiresAt: 0 };
    },
    status: () => ({ status: "wait" }),
    cancel: (handshake) => calls.push(`${name}.cancel:${handshake}`),
    list: async () => rows,
    rename: async (id) => {
        calls.push(`${name}.rename:${id}`);
        return rows.find((row) => row.id === id);
    },
    identityOf: (stored) => stored.email,
    forget: async (id) => {
        calls.push(`${name}.forget:${id}`);
    },
});

const opencodeRow: OauthAccount = { id: "xai", label: "Grok", connectedAt: 0 };
const cliRow: OauthAccount = { id: "c1", label: "Grok Build", connectedAt: 1, email: "me@example.com", variant: "grok-build" };

test("a start names its sign-in by variant: the CLI's door, else OpenCode's", async () => {
    const calls: string[] = [];
    const doors = grokDoors(door("opencode", [opencodeRow], calls), door("cli", [cliRow], calls), async (id) => id === "c1");
    await doors.start("grok-build");
    await doors.start(undefined);
    expect(calls).toEqual(["cli.start:grok-build", "opencode.start:"]);
});

test("both halves' rows list together, and each row's rename and disconnect reach its own half", async () => {
    const calls: string[] = [];
    const doors = grokDoors(door("opencode", [opencodeRow], calls), door("cli", [cliRow], calls), async (id) => id === "c1");
    expect(await doors.list(false)).toEqual([opencodeRow, cliRow]);
    await doors.rename("c1", "work");
    await doors.forget("xai");
    expect(calls).toEqual(["cli.rename:c1", "opencode.forget:xai"]);
    // OpenCode's single row has no identity to match; the CLI's rows are matched as any account's are.
    expect(doors.identityOf(opencodeRow)).toBeUndefined();
    expect(doors.identityOf(cliRow)).toBe("me@example.com");
});
