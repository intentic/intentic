import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { call } from "@orpc/server";
import { unstubbed } from "@intentic/testing";
import type { ProvenCaller } from "../auth/auth.js";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { createAiLiteracyRoutes } from "./ai-literacy.routes.js";

const fixture = () => {
    let settings = SandboxSettingsSchema.parse({});
    const root = mkdtempSync(join(tmpdir(), "ai-notice-"));
    const routes = createAiLiteracyRoutes(unstubbed<Services>("services", {
        config: unstubbed<Services["config"]>("config", { historyRoot: root }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("settings", { get: async () => settings }),
    }));
    return { routes, setNotice: (show: boolean, text: string) => { settings = { ...settings, aiNotice: { show, text } }; } };
};
const as = (email: string) => {
    const identity: ProvenCaller = { email, role: "viewer", methods: ["google"] };
    const context: OrpcContext = { identity, headers: new Headers(), method: "GET", url: "/settings/ai-literacy/en" };
    return { context };
};

test("notice is off by default", async () => {
    const { routes } = fixture();
    expect((await call(routes.aiLiteracy, { locale: "en" }, as("member@example.org"))).show).toBe(false);
    expect((await call(routes.aiLiteracy, { locale: "en" }, as("member@example.org"))).confirmedAt).toBeUndefined();
});

test("confirmation is kept for one member and the notice reopens when its text changes", async () => {
    const { routes, setNotice } = fixture();
    setNotice(true, "Check your sources.");
    const before = await call(routes.aiLiteracy, { locale: "en" }, as("member@example.org"));
    expect(before.confirmedAt).toBeUndefined();
    const confirmed = await call(routes.confirmAiLiteracy, { version: before.version, locale: "en" }, as("member@example.org"));
    expect(confirmed.confirmedAt).toEqual(expect.any(String));
    if (confirmed.confirmedAt === undefined) {
        throw new Error("confirmation route omitted its timestamp");
    }
    expect((await call(routes.aiLiteracy, { locale: "en" }, as("other@example.org"))).confirmedAt).toBeUndefined();
    expect((await call(routes.aiLiteracyConfirmations, undefined, as("member@example.org"))).records).toEqual([
        { member: "member@example.org", version: before.version, confirmedAt: confirmed.confirmedAt },
    ]);
    setNotice(true, "Check every source.");
    const changed = await call(routes.aiLiteracy, { locale: "en" }, as("member@example.org"));
    expect(changed.confirmedAt).toBeUndefined();
    expect(changed.version).not.toBe(before.version);
    await expect(call(routes.confirmAiLiteracy, { version: before.version, locale: "en" }, as("member@example.org"))).rejects.toThrow("changed");
});
