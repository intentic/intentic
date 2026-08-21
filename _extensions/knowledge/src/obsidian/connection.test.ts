import { describe, expect, it } from "vitest";
import { normaliseUrl, selectVault, vaultConnections } from "./connection.js";

const env = (suffix: string, overrides: Record<string, string> = {}): Record<string, string> => ({
    [`OBSIDIAN_URL_${suffix}`]: "https://host.docker.internal:27124",
    [`OBSIDIAN_API_KEY_${suffix}`]: "key",
    [`OBSIDIAN_WRITE_${suffix}`]: "off",
    [`OBSIDIAN_FOLDER_${suffix}`]: "",
    ...overrides,
});

describe("vaultConnections", () => {
    it("finds one connection per OBSIDIAN_URL_* and names it after the suffix", () => {
        const found = vaultConnections({ ...env("OBSIDIAN"), ...env("WORK_VAULT"), PATH: "/usr/bin" });
        expect(found.map((connection) => connection.name)).toEqual(["obsidian", "work_vault"]);
        expect(found.every((connection) => connection.problem === undefined)).toBe(true);
    });

    it("reads the write switch as the card's on/off", () => {
        expect(vaultConnections(env("V", { OBSIDIAN_WRITE_V: "on" }))[0]?.write).toBe(true);
        expect(vaultConnections(env("V", { OBSIDIAN_WRITE_V: "off" }))[0]?.write).toBe(false);
        // Nothing at all on the card is the same answer as off: a missing switch must never read as consent.
        expect(vaultConnections(env("V", { OBSIDIAN_WRITE_V: "" }))[0]?.write).toBe(false);
    });

    it("keeps a half-filled card as a connection with a problem, not as no connection", () => {
        const [connection] = vaultConnections(env("V", { OBSIDIAN_API_KEY_V: "" }));
        expect(connection?.name).toBe("v");
        expect(connection?.problem).toContain("API key");
    });

    it("trims the folder's slashes so a path is never built with two", () => {
        expect(vaultConnections(env("V", { OBSIDIAN_FOLDER_V: "/Inbox/" }))[0]?.folder).toBe("Inbox");
    });

    it("ignores an environment with no Obsidian card in it", () => {
        expect(vaultConnections({ HOME: "/root", OBSIDIAN_URL: "no suffix, not a card" })).toEqual([]);
    });
});

describe("normaliseUrl", () => {
    it("drops trailing slashes and assumes https for a bare host", () => {
        expect(normaliseUrl("https://host.docker.internal:27124/")).toBe("https://host.docker.internal:27124");
        expect(normaliseUrl("host.docker.internal:27124")).toBe("https://host.docker.internal:27124");
        expect(normaliseUrl("http://127.0.0.1:27123")).toBe("http://127.0.0.1:27123");
        expect(normaliseUrl("  ")).toBe("");
    });
});

describe("selectVault", () => {
    const connections = vaultConnections({ ...env("HOME_VAULT"), ...env("WORK") });

    it("takes the only connection without being told which", () => {
        const one = vaultConnections(env("WORK"));
        expect(selectVault(one, undefined)).toEqual({ vault: one[0] });
    });

    it("asks which one rather than guessing between two", () => {
        const result = selectVault(connections, undefined);
        expect(result).toHaveProperty("error");
        expect("error" in result && result.error).toContain("--vault");
    });

    it("selects by the name it prints, however it is cased or punctuated", () => {
        expect(selectVault(connections, "home_vault")).toEqual({ vault: connections[0] });
        expect(selectVault(connections, "HOME-VAULT")).toEqual({ vault: connections[0] });
    });

    it("names what is connected when the asked-for one is not", () => {
        const result = selectVault(connections, "nope");
        expect("error" in result && result.error).toContain("home_vault");
    });

    it("says nothing is connected rather than which, when nothing is", () => {
        expect(selectVault([], undefined)).toEqual({ error: expect.stringContaining("no Obsidian vault is connected") });
    });
});
