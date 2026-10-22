import { join } from "node:path";
import { createApp } from "../../app.js";
import { clientFor, collect } from "../../harness/route-client.testing.js";
import { tempWorkspace } from "../../harness/route-fakes.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../capabilities-slice.testing.js";

test("adding Pi before its CLI is installed saves the capability and includes its install layer in the rebuild", async () => {
    const workspace = tempWorkspace([]);
    const capabilities = memoryCapabilitiesStore();
    const daemon = services({ workspace, capabilities });
    const client = clientFor(createApp(daemon));
    const config = { command: join(workspace.root, "missing-pi"), loginCommand: "pi" };

    const lines = await collect(await client.capabilities.add({ id: "pi", kind: "agent", config }));
    expect(lines.at(-1)).toEqual({ kind: "result", ok: true });
    expect(lines).toContainEqual({
        kind: "log",
        message: "Pi is not installed yet. Rebuild the sandbox from Sandbox > Environment, then sign in to Pi.",
    });
    const stored = await capabilities.get("pi");
    expect(stored).toEqual({ id: "pi", kind: "agent", config });
    expect((await client.capabilities.status({ id: "pi" })).state).toBe("pending");
    const fragments = await daemon.environmentSources.capabilityFragments({ id: "pi", kind: "agent", config });
    expect(fragments.join("\n")).toContain("npm install -g --ignore-scripts @earendil-works/pi-coding-agent@");
});
