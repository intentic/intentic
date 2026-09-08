import type { BrowserConfig, Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fakeFiles, tempWorkspace } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../harness/route-stores.testing.js";
import { loadedSkillFile } from "../settings/loaded-skills.js";
import { openBrowserAccount } from "./open-account.js";

// Pins that no site is unfileable: a signup the agent can perform must always be one it can record, never one that
// falls back to a hand-maintained list.

const identity = (id: string, openAccounts: "on" | "off"): Capability =>
    ({ id, kind: "identity", config: { email: `${id}@gmail.com`, openAccounts } }) as Capability;

// Writes are recorded, not performed: what matters is that the account's skill gets written at all, not its rendered
// content.
const harness = (entries: Capability[]) => {
    const store = memoryCapabilitiesStore(entries);
    const written = new Map<string, string>();
    // Decodes the binary arm too, matching the real writer's signature instead of narrowing it.
    const files = fakeFiles({
        write: async (path: string, content: string | Uint8Array) =>
            void written.set(path, typeof content === "string" ? content : new TextDecoder().decode(content)),
    });
    return { store, written, services: services({ workspace: tempWorkspace([]), capabilities: store, files }) };
};

const configOf = async (store: ReturnType<typeof memoryCapabilitiesStore>, id: string): Promise<BrowserConfig> =>
    (await store.get(id))?.config as BrowserConfig;

test("files a carded site on its own card, with the account's purpose and the date it was opened", async () => {
    const { store, written, services: deps } = harness([identity("scout", "on")]);

    await openBrowserAccount(deps, { id: "reddit-scout", platform: "reddit", identity: "scout", purpose: "community research" });

    const config = await configOf(store, "reddit-scout");
    expect(config.platform).toBe("reddit");
    expect(config.identity).toBe("scout");
    expect(config.purpose).toBe("community research");
    // Plain date, not a timestamp: "roughly when" is the precision this fact actually has.
    expect(config.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Card pins its own URLs; the entry must not carry a second opinion about them.
    expect(config["homeUrl"]).toBeUndefined();
    // One skill per site, never per account: a roster line is what makes the account real to the agent.
    expect(written.get(loadedSkillFile(deps.workspace.root, "reddit"))).toContain("- `reddit-scout`");
});

test("files an uncarded site on the generic session rather than refusing it", async () => {
    const { store, services: deps } = harness([identity("scout", "on")]);

    const report = await openBrowserAccount(deps, {
        id: "producthunt-scout",
        platform: "producthunt",
        identity: "scout",
        purpose: "launch listings",
        homeUrl: "https://www.producthunt.com/",
    });

    const config = await configOf(store, "producthunt-scout");
    expect(config.platform).toBe("website");
    expect(config["homeUrl"]).toBe("https://www.producthunt.com/");
    expect(config.purpose).toBe("launch listings");
    // Said out loud: the agent asked for a platform and got a card that knows nothing about the site.
    expect(report).toContain('No site card for "producthunt"');
});

// Generic card pins no URL: an uncarded site with none has nowhere to open, caught here while the agent can still
// answer it.
test("refuses an uncarded site with no address, and says which field would fix it", async () => {
    const { services: deps } = harness([identity("scout", "on")]);

    await expect(
        openBrowserAccount(deps, { id: "producthunt-scout", platform: "producthunt", identity: "scout", purpose: "launch listings" }),
    ).rejects.toThrow(/homeUrl/);
});

// An account with no stated purpose is one a later session can't decide whether to reuse, the only question this record
// answers.
test("refuses an account with no purpose", async () => {
    const { services: deps } = harness([identity("scout", "on")]);

    await expect(openBrowserAccount(deps, { id: "reddit-scout", platform: "reddit", identity: "scout", purpose: "   " })).rejects.toThrow(
        /what "reddit-scout" is for/,
    );
});

// Consent is re-checked on every call and outranks everything else: an identity with signup off refuses before any
// filing happens.
test("refuses to open an account through an identity whose owner did not allow it", async () => {
    const { store, services: deps } = harness([identity("scout", "off")]);

    await expect(
        openBrowserAccount(deps, { id: "reddit-scout", platform: "reddit", identity: "scout", purpose: "community research" }),
    ).rejects.toThrow(/may not open accounts/);
    expect(await store.get("reddit-scout")).toBeUndefined();
});
