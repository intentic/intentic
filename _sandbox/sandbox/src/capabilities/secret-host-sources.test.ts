import { unstubbed } from "@intentic/testing";
import type { ExtensionHost } from "./extension-inventory/installed-extensions.js";
import { secretHostSources } from "./secret-host-sources.js";

test("connector metadata uses the raw manifest host while enforcement retains the hydrated host", async () => {
    const host = unstubbed<ExtensionHost>("hydrated host", {});
    const manifestHost = unstubbed<ExtensionHost>("manifest host", {});
    const hosts = new Map([["service", ["api.example.com"]]]);
    const read = jest.fn(async (selected: ExtensionHost) => {
        if (selected === host) { throw new Error("must not read credential configuration"); }
        expect(selected).toBe(manifestHost);
        return hosts;
    });
    const sources = secretHostSources(host, { manifestHost }, read);
    expect(await sources.connectorHostMetadata()).toBe(hosts);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(sources.connectorHosts()).rejects.toThrow("must not read credential configuration");
});
