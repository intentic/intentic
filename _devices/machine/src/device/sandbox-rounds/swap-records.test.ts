import { join } from "node:path";
import { homeDir } from "@intentic/local-agent";
import { icHome, slugOfRecord } from "./swap-records.js";

/* What is left of ic's channel records here: where they live and which files are one. Whether a swap is going on is
ic's to say (ic-swaps.test.ts), and the fallback for an ic that cannot says it by the contract's fixture
(swaps-fallback.test.ts). */

test("only ic's own record files name a slug", () => {
    expect(slugOfRecord("sandbox-work.channel")).toBe("work");
    // ic names a sandbox with a public hostname by that hostname's first label, which itself starts `sandbox-`.
    expect(slugOfRecord("sandbox-sandbox-0123456789ab.channel")).toBe("sandbox-0123456789ab");
    expect(slugOfRecord("sandbox-.channel")).toBeUndefined();
    expect(slugOfRecord("sandbox-work.channel.tmp")).toBeUndefined();
    expect(slugOfRecord("backups")).toBeUndefined();
});

test("ic's home is INTENTIC_HOME when set, else .intentic under this agent's home", () => {
    expect(icHome({ INTENTIC_HOME: "/srv/ic" })).toBe("/srv/ic");
    expect(icHome({ INTENTIC_HOME: "" })).toBe(join(homeDir(), ".intentic"));
    expect(icHome({})).toBe(join(homeDir(), ".intentic"));
});
