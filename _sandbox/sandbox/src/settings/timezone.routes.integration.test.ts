import { type SandboxSettings, SandboxSettingsSchema, ZoneSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { createSettingsRoutes } from "./settings.routes.js";

// `adoptTimezone` is the one settings write that must refuse to overwrite. Every browser that opens a workspace calls
// it, so "last one wins" would mean a colleague in Tokyo silently moving an owner's nightly chores eight hours.

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/settings/timezone" };

// A store that behaves like the real one for this route's purposes: `set` replaces whole, `get` returns what was set.
const settingsServices = (initial: Partial<SandboxSettings> = {}): Services => {
    let stored = SandboxSettingsSchema.parse(initial);
    return unstubbed<Services>("services", {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => stored,
            set: async (next: SandboxSettings) => {
                stored = next;
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {} }),
    });
};

test("a sandbox with no clock takes the one the browser offers", async () => {
    const services = settingsServices();
    const routes = createSettingsRoutes(services);

    await expect(call(routes.adoptTimezone, { timezone: ZoneSchema.parse("Europe/Warsaw") }, { context })).resolves.toEqual({
        timezone: "Europe/Warsaw",
        adopted: true,
    });
    expect((await services.sandboxSettings.get()).timezone).toBe("Europe/Warsaw");
});

/* THE ONE THAT MATTERS: the second browser, and the tenth, change nothing. */
test("a sandbox that already has one keeps it, whatever the next browser offers", async () => {
    const services = settingsServices({ timezone: ZoneSchema.parse("Europe/Warsaw") });
    const routes = createSettingsRoutes(services);

    await expect(call(routes.adoptTimezone, { timezone: ZoneSchema.parse("Asia/Tokyo") }, { context })).resolves.toEqual({
        timezone: "Europe/Warsaw",
        adopted: false,
    });
    expect((await services.sandboxSettings.get()).timezone).toBe("Europe/Warsaw");
});

// The rest of the settings are untouched by an adoption: the route reads the whole object and writes it back with one
// field changed, and a store that dropped the remainder would silently reset every toggle on the Agent screen.
test("adopting a clock leaves every other setting exactly as it was", async () => {
    const services = settingsServices({ hashlineEdits: true, systemPrompt: "Be brief." });
    const routes = createSettingsRoutes(services);

    await call(routes.adoptTimezone, { timezone: ZoneSchema.parse("Asia/Tokyo") }, { context });

    const after = await services.sandboxSettings.get();
    expect(after.hashlineEdits).toBe(true);
    expect(after.systemPrompt).toBe("Be brief.");
});
