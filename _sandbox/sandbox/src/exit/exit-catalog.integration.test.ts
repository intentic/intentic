import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitConfigSchema } from "@intentic/sandbox-contract";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { TOR_FALLBACK, VPNGATE_FALLBACK } from "./exit-countries.js";
import { catalogPath } from "./exit-paths.js";
import { torDriver } from "./tor.js";
import { vpngateDriver } from "./vpngate.js";

// A provider's catalog is cached off the network under HOME; what is read back is checked, never cast, so a cache a cut
// write or another build left reads as no cache at all.

let home = "";
const previousHome = process.env["HOME"];

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "exit-catalog-"));
    process.env["HOME"] = home;
    await mkdir(join(home, ".intentic-exit"), { recursive: true });
});

afterEach(async () => {
    unstubAllGlobals();
    process.env["HOME"] = previousHome;
    await rm(home, { recursive: true, force: true });
});

const TOR = ExitConfigSchema.parse({ provider: "tor" });
const VPNGATE = ExitConfigSchema.parse({ provider: "vpngate" });

const offline = (): void => stubGlobal("fetch", async () => new Response("", { status: 503 }));

test("a malformed cache inside its TTL reads as nothing cached, so the baked list answers", async () => {
    offline();
    await writeFile(catalogPath("tor"), JSON.stringify({ at: Date.now(), countries: "garbage" }));
    await writeFile(catalogPath("vpngate"), JSON.stringify({ at: Date.now(), servers: [{ host: 1 }] }));
    expect(await torDriver.catalog("berlin", TOR)).toEqual({ countries: TOR_FALLBACK, live: false });
    expect(await vpngateDriver.catalog("tokyo", VPNGATE)).toEqual({ countries: VPNGATE_FALLBACK, live: false });
});

test("a fresh catalog is written atomically, 0600, under its provider's key, and served from there inside its TTL", async () => {
    const relays = { relays: [{ country: "de", exit_probability: 0.5 }, { country: "nl", exit_probability: 0.2 }] };
    stubGlobal("fetch", async () => Response.json(relays));
    const fresh = await torDriver.catalog("berlin", TOR);
    expect(fresh.live).toBe(true);
    expect(fresh.countries.map((point) => point.country)).toEqual(["DE", "NL"]);
    const stored = JSON.parse(await readFile(catalogPath("tor"), "utf8")) as { countries: unknown };
    expect(stored.countries).toEqual(fresh.countries);
    // oxlint-disable-next-line no-bitwise -- the permission bits are the assertion
    expect((await stat(catalogPath("tor"))).mode & 0o777).toBe(0o600);
    offline();
    expect(await torDriver.catalog("berlin", TOR)).toEqual(fresh);
});
