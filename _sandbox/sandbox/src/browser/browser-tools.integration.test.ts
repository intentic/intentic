import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { browserServerSpec, browserServersOf, isolatedBrowserSpec, writeBrowserConfig } from "./browser-tools.js";
import { acquireProfileLock, markConnected, releaseProfileLock } from "./session-store.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "browser-tools-"));
const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };

// Whether the image actually has Chromium decides what browserServersOf can return, and CI images may not.
// Asserting the SHAPE of each spec is version-independent; the wiring test below adapts.
const chromiumInstalled = async (): Promise<boolean> => Object.keys((await browserServersOf([], tempRoot())).servers).length > 0;

test("browser MCP configs live in a private directory, each one written exclusively", async () => {
    const server = `permissions-${process.hrtime.bigint()}`;
    const path = await writeBrowserConfig(server, 41_237);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
});

/* THE REGRESSION: a recycled port must not end the turn.
 *
 * Ports are reissued once the port memory has rolled past them — a dozen turns, in a sandbox with twenty
 * accounts — while the config file the earlier turn wrote is still on disk for hours. Named owner+port, the
 * second write hit `wx` and threw EEXIST out of turn planning, killing the turn before the model ran. */
test("a recycled port writes its own config instead of colliding with the old one", async () => {
    const server = `recycled-${process.hrtime.bigint()}`;
    const first = await writeBrowserConfig(server, 41_237);
    const second = await writeBrowserConfig(server, 41_237);
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    expect(statSync(second).mode & 0o777).toBe(0o600);
});

/* Every daemon restart used to leave its config directory behind forever — hundreds of them in a long-lived
 * sandbox. The stale sweep now takes the directories too, without touching the one this process is writing to. */
test("config directories left by dead daemons are swept, and the live one is kept", async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const dead = mkdtempSync(join(tmpdir(), "intentic-browser-mcp-"));
    const stale = new Date(Date.now() - 7 * 3_600_000);
    writeFileSync(join(dead, "web-40000-abcdef01.json"), "{}");
    utimesSync(join(dead, "web-40000-abcdef01.json"), stale, stale);
    utimesSync(dead, stale, stale);

    const { servers } = await browserServersOf([], tempRoot());

    expect(existsSync(dead)).toBe(false);
    // …while this turn's own config, in the live directory, survived the very same pass.
    const args = (servers["web"] as { args: string[] }).args;
    expect(existsSync(args[args.indexOf("--config") + 1] as string)).toBe(true);
});

test("browserServerSpec is a HEADED stdio server bound to the profile + stealth + display", () => {
    const spec = browserServerSpec(
        "cli.js",
        "/ms/chrome",
        `${WORKSPACE_ROOT}/${STATE_DIR}/local/browser/reddit`,
        `${WORKSPACE_ROOT}/${STATE_DIR}/local/browser/stealth.js`,
        ":99",
        "/tmp/cfg.json",
    ) as {
        type: string;
        command: string;
        args: string[];
        env: Record<string, string>;
    };
    expect(spec.type).toBe("stdio");
    expect(spec.args).toContain("chromium");
    expect(spec.args).toContain("--user-data-dir");
    expect(spec.args).toContain("/work/.intentic/local/browser/reddit");
    expect(spec.args).toContain("--init-script");
    expect(spec.args).toContain("/work/.intentic/local/browser/stealth.js");
    expect(spec.args).toContain("--no-sandbox");
    // The config file is what carries --remote-debugging-port, and so what makes the browser watchable.
    expect(spec.args).toContain("--config");
    expect(spec.args).toContain("/tmp/cfg.json");
    // Headed, not the fingerprinted headless shell, and rendering to the shared Xvfb.
    expect(spec.args).not.toContain("--headless");
    expect(spec.env["DISPLAY"]).toBe(":99");
});

/* The deadline, on both server kinds. Without it a browser tool call is unbounded — and one of these tools
 * genuinely never returns on its own: `browser_evaluate` awaits an in-page promise, which Playwright does not
 * time out, so a page that never reaches the awaited state ends the turn there. It is a PER-SERVER timeout
 * rather than MCP_TOOL_TIMEOUT because the same process serves tools that must wait for a human. */
test("every browser server bounds a single tool call", () => {
    const specs = [
        browserServerSpec("cli.js", "/ms/chrome", "/profile", "/stealth.js", ":99", "/tmp/cfg.json"),
        isolatedBrowserSpec("cli.js", "/ms/chrome", "/out", "/tmp/cfg.json"),
    ] as { timeout?: number }[];
    for (const spec of specs) {
        expect(spec.timeout).toBeGreaterThan(60_000); // clears @playwright/mcp's own 60s navigation timeout
        expect(spec.timeout).toBeLessThanOrEqual(180_000); // …and still ends a wedged call inside a turn
    }
});

// The credential-free browser carries no identity at all — that is what lets it exist without a login, and
// what lets two turns run one at once.
test("isolatedBrowserSpec keeps the profile in memory and needs no display", () => {
    const spec = isolatedBrowserSpec("cli.js", "/ms/chrome", `${WORKSPACE_ROOT}/${STATE_DIR}/records/artifacts/browser`, "/tmp/cfg.json") as {
        args: string[];
        env: Record<string, string>;
    };
    expect(spec.args).toContain("--isolated");
    expect(spec.args).toContain("--headless");
    expect(spec.args).toContain("--output-dir");
    expect(spec.args).toContain("/work/.intentic/records/artifacts/browser");
    expect(spec.args).not.toContain("--user-data-dir");
    expect(spec.args).not.toContain("--init-script");
    expect(spec.env["DISPLAY"]).toBeUndefined();
});

// The regression this whole path exists for: an agent asked to look at a URL used to get NO browser unless the
// owner had logged one into a social platform, so it went and downloaded Chromium by hand.
test("a browser is available with no capabilities and no login at all", async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    expect(Object.keys((await browserServersOf([], tempRoot())).servers)).toEqual(["web"]);
    const github: Capability = { id: "gh", kind: "cli", config: { provider: "github", token: "x" } };
    expect(Object.keys((await browserServersOf([github], tempRoot())).servers)).toEqual(["web"]);
});

/* A PENDING account's browser mounts too — over the same persisted profile the guided login would write. This
 * is what lets the agent perform the sign-in (or sign-up) itself and leave the account exactly as connected as
 * a hand login would have; the connected marker gates nothing here any more, only the profile lock does. Needs
 * the virtual display like every persisted-profile server, so guarded like the two-accounts test below. */
test("a browser capability mounts the ONE routed server before anyone has logged in", async () => {
    if (!(await chromiumInstalled()) || !existsSync("/usr/bin/Xvfb")) {
        return;
    }
    const { servers, accounts, passkeys } = await browserServersOf([reddit], tempRoot());
    expect(Object.keys(servers).toSorted()).toEqual(["browser", "web"]);
    expect(accounts["reddit"]).toBe("reddit");
    // The passkey store is armed from the first page: a sign-UP is exactly when the account enrolls its key.
    expect(passkeys["reddit"]).toBeDefined();
});

test("a login in progress suppresses that account's server (the profile is locked)", async () => {
    if (!(await chromiumInstalled())) {
        return;
    }
    const root = tempRoot();
    await markConnected(root, "reddit");
    expect(acquireProfileLock("reddit")).toBe(true);
    // The credential-free browser is unaffected — it holds no profile to lock.
    expect(Object.keys((await browserServersOf([reddit], root)).servers)).toEqual(["web"]);
    releaseProfileLock("reddit");
});

/* TWO ACCOUNTS OF ONE SITE ARE TWO BROWSERS behind the ONE routed server, in the same turn. Each backend in
 * the router's manifest gets its own --user-data-dir (which is the fix): pointed at one shared directory they
 * would not merely be confusable, they would be unusable, because Chromium takes an exclusive lock on a
 * profile — the first backend to launch would work and the second would fail on its first call.
 *
 * The logged-in path needs the virtual display, which the sandbox image has and a dev host may not; guarded like
 * the Chromium probe above rather than left to throw somewhere it was never going to run. */
test("accounts of the same site each get their own backend on their own profile, behind one server", async () => {
    if (!(await chromiumInstalled()) || !existsSync("/usr/bin/Xvfb")) {
        return;
    }
    const root = tempRoot();
    const work: Capability = { id: "reddit-work", kind: "browser", config: { platform: "reddit" } };
    const personal: Capability = { id: "reddit-personal", kind: "browser", config: { platform: "reddit" } };
    await markConnected(root, "reddit-work");
    await markConnected(root, "reddit-personal");

    const { servers, accounts, passkeys } = await browserServersOf([work, personal], root);

    // The prompt pays for ONE server however many accounts stand behind it.
    expect(Object.keys(servers).toSorted()).toEqual(["browser", "web"]);
    expect(accounts).toEqual({ "reddit-work": "reddit-work", "reddit-personal": "reddit-personal" });
    const routerArgs = (servers["browser"] as { args: string[] }).args;
    const manifest = JSON.parse(readFileSync(routerArgs[1] as string, "utf8")) as {
        accounts: Record<string, string>;
        owners: Record<string, { args: string[] }>;
    };
    expect(manifest.accounts).toEqual(accounts);
    const dirOf = (id: string): string | undefined => {
        const args = manifest.owners[id]?.args ?? [];
        return args[args.indexOf("--user-data-dir") + 1];
    };
    expect(dirOf("reddit-work")).toBe(join(root, ".intentic", "local", "browser", "reddit-work"));
    expect(dirOf("reddit-personal")).toBe(join(root, ".intentic", "local", "browser", "reddit-personal"));
    // Their software security keys are separate too — one account's second factor is not the other's.
    expect(passkeys["reddit-work"]).not.toBe(passkeys["reddit-personal"]);
});

// An identity and an account born from it are ONE backend — the shared profile — addressable by either id.
test("an identity-born account routes to its identity's browser", async () => {
    if (!(await chromiumInstalled()) || !existsSync("/usr/bin/Xvfb")) {
        return;
    }
    const root = tempRoot();
    const main: Capability = { id: "main", kind: "identity", config: { email: "studio@gmail.com", openAccounts: "off" } };
    const born: Capability = { id: "reddit-main", kind: "browser", config: { platform: "reddit", identity: "main" } };

    const { servers, accounts, ports } = await browserServersOf([main, born], root);
    expect(Object.keys(servers).toSorted()).toEqual(["browser", "web"]);
    expect(accounts).toEqual({ main: "main", "reddit-main": "main" });
    // One profile owner, one debugging port — the observer's map is per owner, not per account.
    expect(ports["main"]).toBeDefined();
    expect(ports["reddit-main"]).toBeUndefined();
});

// Without the binary there is nothing to drive, and executablePath() alone never says so.
test("no Chromium on disk means no browser servers at all", async () => {
    if (await chromiumInstalled()) {
        return;
    }
    const root = tempRoot();
    await markConnected(root, "reddit");
    expect(await browserServersOf([reddit], root)).toEqual({ servers: {}, accounts: {}, ports: {}, passkeys: {} });
});
