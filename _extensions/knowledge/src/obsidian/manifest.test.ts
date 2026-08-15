import { describe, expect, it } from "vitest";
import { manifest } from "../manifest.js";

/* THE CARD IS DATA, so this is the test that it is data the daemon will accept. `manifest.ts` parses the
 * package's own intentic-extension.json through the real ExtensionManifestSchema, so a typo in the card fails
 * here rather than at install time on somebody's sandbox. */
describe("the Obsidian capability card", () => {
    const card = manifest.contributes?.capabilities?.find((entry) => entry.id === "obsidian");

    it("is declared, as a cli capability", () => {
        expect(card).toBeDefined();
        expect(card?.kind).toBe("cli");
    });

    it("asks for the four things the connection needs, and hides the key", () => {
        expect(card?.fields.map((field) => field.key)).toEqual(["baseUrl", "apiKey", "write", "folder"]);
        expect(card?.fields.find((field) => field.key === "apiKey")?.secret).toBe(true);
    });

    it("defaults the write switch to off — reaching a vault and being allowed to edit it are separate grants", () => {
        const write = card?.fields.find((field) => field.key === "write");
        expect(write?.boolean).toBe(true);
        expect(write?.default).toBe("off");
    });

    it("points the default URL at the host, not at the container", () => {
        expect(card?.fields.find((field) => field.key === "baseUrl")?.default).toContain("host.docker.internal");
    });

    it("hands the CLI exactly the env its connection reader looks for", () => {
        // The keys vaultConnections enumerates and reads. A rename on either side breaks this rather than
        // shipping a card whose credentials the tool cannot find.
        expect(card?.kind === "cli" && card.env).toEqual({
            OBSIDIAN_URL: "${baseUrl}",
            OBSIDIAN_API_KEY: "${apiKey}",
            OBSIDIAN_WRITE: "${write}",
            OBSIDIAN_FOLDER: "${folder}",
        });
    });

    it("names a skill outside plugin/, so it loads with the card rather than every turn", () => {
        expect(card?.kind === "cli" && card.skill).toBe("skills/obsidian/SKILL.md");
    });
});
