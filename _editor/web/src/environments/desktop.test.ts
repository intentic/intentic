import { expect, test, vi } from "vitest";
import type { WebEnvironment } from "./environment";

/* The sync handoff's whole payload is two sender-chosen values the Rust side trusts only from the app's own
 * window (setup_link.rs), so what this file owes is exactness: every value URL-encoded, the flags spelled the
 * way the parser reads them (`present` = true), and no folder ever riding the link — the app collects that in
 * a system dialog, which is the reason the link exists.
 *
 * Deferred import for the same reason scriptCommand.test.ts defers: environment.ts reads window.env at module
 * scope, and this suite runs under the node environment where no setup file has seeded one. */
const load = async (): Promise<typeof import("./desktop")> => {
    vi.resetModules();
    (globalThis as { window?: { env: WebEnvironment } }).window = {
        env: { production: false, api: { url: `` }, auth: { googleClientId: `` }, analytics: { posthogKey: ``, posthogHost: `` }, afterSignOut: `` },
    };
    return import("./desktop");
};

test("the sync link carries the sandbox url and pairing token, encoded", async () => {
    const { desktopSyncLink } = await load();
    const link = desktopSyncLink({ url: `https://sandbox-abc.example.dev`, pair: `tok+/=123`, name: `My Sandbox` });
    const parsed = new URL(link);
    expect(parsed.protocol).toBe(`intentic:`);
    expect(parsed.host).toBe(`sync`);
    expect(parsed.searchParams.get(`url`)).toBe(`https://sandbox-abc.example.dev`);
    expect(parsed.searchParams.get(`pair`)).toBe(`tok+/=123`);
    expect(parsed.searchParams.get(`name`)).toBe(`My Sandbox`);
});

test("flags ride only when set, and a folder never does", async () => {
    const { desktopSyncLink } = await load();
    const bare = new URL(desktopSyncLink({ url: `https://s.example`, pair: `t` }));
    expect(bare.searchParams.get(`takeover`)).toBeNull();
    expect(bare.searchParams.get(`mirror`)).toBeNull();
    expect(bare.searchParams.get(`name`)).toBeNull();
    expect(bare.searchParams.get(`dir`)).toBeNull();

    const full = new URL(desktopSyncLink({ url: `https://s.example`, pair: `t`, takeover: true, mirror: true }));
    expect(full.searchParams.get(`takeover`)).toBe(`1`);
    expect(full.searchParams.get(`mirror`)).toBe(`1`);
});
