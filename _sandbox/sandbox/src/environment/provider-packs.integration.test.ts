import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { packFragment } from "./packs.js";
import { codexConnected } from "../codex/codex-provider.js";
import { providerPackFragments } from "./provider-packs.js";

/* The provider-side fragment source: a pack rides the overlay exactly when its provider is CONNECTED. The
 * assertions compare against packFragment() through the same default stamp dir the source itself reads, so
 * they hold wherever the suite runs: in a dev checkout every wanted pack is a real fragment; inside a
 * standard image (stamped base) both sides collapse to "nothing to compose", which is itself the contract. */

const services = (openaiApiKey: string, xai: boolean, authRoot: string): Services =>
    unstubbed<Services>("services", {
        config: unstubbed<Services["config"]>("config", { openaiApiKey }),
        authRoot,
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => xai }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
    });

const emptyAuth = (): string => mkdtempSync(join(tmpdir(), "provider-packs-"));

test("nothing connected. no provider fragments ride the overlay", async () => {
    expect(await providerPackFragments(services("", false, emptyAuth()))).toEqual([]);
});

test("an OPENAI_API_KEY alone wants the codex pack, and only it", async () => {
    const fragments = await providerPackFragments(services("sk-test", false, emptyAuth()));
    expect(fragments).toEqual([await packFragment("codex")].filter((fragment) => fragment !== undefined));
});

test("an xAI sign-in wants the opencode pack, and only it", async () => {
    const fragments = await providerPackFragments(services("", true, emptyAuth()));
    expect(fragments).toEqual([await packFragment("opencode")].filter((fragment) => fragment !== undefined));
});

// One subscription on disk answers twice: the translator has something to serve (its pack), and a codex-type
// subscription is how a Codex turn is served (that pack too): the file is the truth, no proxy asked.
test("a codex subscription in the translator's auth dir wants the codex AND translator packs", async () => {
    const authRoot = emptyAuth();
    mkdirSync(join(authRoot, "cliproxy"), { recursive: true });
    writeFileSync(join(authRoot, "cliproxy", "codex-user.json"), JSON.stringify({ type: "codex" }));
    const svc = services("", false, authRoot);
    expect(await codexConnected(svc)).toBe(true);
    const fragments = await providerPackFragments(svc);
    const expected = [await packFragment("codex"), await packFragment("translator")].filter((fragment) => fragment !== undefined);
    expect(fragments).toEqual(expected);
});

// A half-written auth file (a login still polling) is not a connection, and must not crash the compose.
test("an unparseable auth file counts as no subscription", async () => {
    const authRoot = emptyAuth();
    mkdirSync(join(authRoot, "cliproxy"), { recursive: true });
    writeFileSync(join(authRoot, "cliproxy", "codex-user.json"), "{half a jso");
    expect(await providerPackFragments(services("", false, authRoot))).toEqual([]);
});
