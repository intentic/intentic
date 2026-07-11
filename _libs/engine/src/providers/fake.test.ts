import { expect, test } from "vitest";

import { makeContext } from "../reconcile/reconcile.js";
import { createStore } from "../store.js";
import { createFakeProviders } from "./fake.js";

const ctxFor = (id: string) => makeContext(id, createStore(), {}, () => {});

test("read is undefined before apply and defined after, with deterministic outputs", async () => {
    const { providers, world } = createFakeProviders();
    const forgejo = providers["forgejo"];
    if (forgejo === undefined) {
        throw new Error("expected a forgejo provider");
    }
    const ctx = ctxFor("host-git");

    expect(await forgejo.read({}, ctx)).toBeUndefined();

    const produced = await forgejo.apply({}, undefined, ctx);
    expect(produced).toEqual({
        url: "https://host-git.fake.test/url",
        internalUrl: "https://host-git.fake.test/internalUrl",
        runnerToken: "host-git::runnerToken",
        gitToken: "host-git::gitToken",
        packagesToken: "host-git::packagesToken",
    });
    expect(await forgejo.read({}, ctx)).toEqual({ outputs: produced });
    expect(world.has("host-git")).toBe(true);
});

test("list returns only the entries of that provider's kind", async () => {
    const { providers } = createFakeProviders();
    const host = providers["host"];
    const forgejo = providers["forgejo"];
    if (host === undefined || forgejo === undefined || host.list === undefined || forgejo.list === undefined) {
        throw new Error("expected host and forgejo providers with list");
    }
    await host.apply({}, undefined, ctxFor("host"));
    await forgejo.apply({}, undefined, ctxFor("host-git"));

    expect(await host.list([], ctxFor(""))).toEqual([{ id: "host", inputs: {} }]);
    expect(await forgejo.list([], ctxFor(""))).toEqual([{ id: "host-git", inputs: {} }]);
});
