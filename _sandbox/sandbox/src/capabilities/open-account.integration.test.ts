import type { BrowserConfig, Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fakeFiles, memoryCapabilitiesStore, services, tempWorkspace } from "../route-testing.js";
import { loadedSkillFile } from "../settings/loaded-skills.js";
import { openBrowserAccount } from "./open-account.js";

/* THE AGENT FILING AN ACCOUNT IT JUST OPENED. What these hold is the one property the whole records-of-accounts
 * design rests on: NO SITE IS UNFILEABLE. The moment a signup the agent can perform is a signup it cannot
 * record, the record moves to a file somebody maintains by hand, which is exactly where it had gone, and that
 * file was stale within days of being written. */

const identity = (id: string, openAccounts: "on" | "off"): Capability =>
    ({ id, kind: "identity", config: { email: `${id}@gmail.com`, openAccounts } }) as Capability;

// Writes are recorded rather than performed: what matters here is that the account's skill is written at all
// (an account with no skill is an entry the agent never learns it has), not what the renderer put in it.
const harness = (entries: Capability[]) => {
    const store = memoryCapabilitiesStore(entries);
    const written = new Map<string, string>();
    // Skills are written as text; the binary arm of the writer's signature is decoded rather than refused so
    // this fake matches the real one instead of narrowing it.
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
    // Stamped as a plain date rather than an instant: what a later session needs is "roughly when", and a full
    // timestamp reads like a precision this fact does not have.
    expect(config.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The card's own URLs are pinned, so the entry must not carry a second opinion about them.
    expect(config["homeUrl"]).toBeUndefined();
    // The account is real the moment it is filed: a roster line on the SITE's skill is what gives the agent
    // the playbook: one skill per site, never one per account.
    expect(written.get(loadedSkillFile(deps.workspace.root, "reddit"))).toContain("- `reddit-scout`");
});

/* THE CASE THAT USED TO BE REFUSED. An uncarded site: the four Product Hunt accounts this replaced were exactly
 * this: now rides the generic browser session instead of failing, so the signup can be recorded where every
 * other account lives rather than in prose somewhere. */
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
    // Said out loud, because the agent asked for a platform and got a card that knows nothing about the site.
    expect(report).toContain('No site card for "producthunt"');
});

// The generic card pins no URLs, so an uncarded site with no address has nowhere to open: caught here, where
// the agent can still answer it, rather than later as a browser that comes up blank.
test("refuses an uncarded site with no address, and says which field would fix it", async () => {
    const { services: deps } = harness([identity("scout", "on")]);

    await expect(
        openBrowserAccount(deps, { id: "producthunt-scout", platform: "producthunt", identity: "scout", purpose: "launch listings" }),
    ).rejects.toThrow(/homeUrl/);
});

// An account nobody can say the point of is one a later session cannot decide whether to reuse, which is the
// only question the record exists to answer.
test("refuses an account with no purpose", async () => {
    const { services: deps } = harness([identity("scout", "on")]);

    await expect(openBrowserAccount(deps, { id: "reddit-scout", platform: "reddit", identity: "scout", purpose: "   " })).rejects.toThrow(
        /what "reddit-scout" is for/,
    );
});

/* The consent switch is re-checked on every call and outranks everything above it: an identity whose owner never
 * turned signup on refuses before any of the filing happens. */
test("refuses to open an account through an identity whose owner did not allow it", async () => {
    const { store, services: deps } = harness([identity("scout", "off")]);

    await expect(
        openBrowserAccount(deps, { id: "reddit-scout", platform: "reddit", identity: "scout", purpose: "community research" }),
    ).rejects.toThrow(/may not open accounts/);
    expect(await store.get("reddit-scout")).toBeUndefined();
});
