import { createFakeProviders } from "@intentic/engine";
import type { ResourceNode } from "@intentic/graph";
import type { SshExecutor } from "@intentic/providers";
import type { RetiredHost } from "./baseline.js";
import { scanRetiredHosts } from "./retired-hosts.js";

const oldHost = (address: string): RetiredHost => ({
    id: "host",
    address,
    node: {
        id: "host",
        type: "host",
        inputs: { address, user: "deploy", sshKey: { $secret: { source: "env", key: "HOST_SSH_KEY" } } },
        dependsOn: [],
    } as ResourceNode,
    since: "2026-10-05",
});

// One old machine answers the stamped-container table; another is gone.
const executor = (table: string): SshExecutor => ({
    connect: async (target) => {
        if (target.address === "10.0.0.66") {
            throw new Error("connect ECONNREFUSED");
        }
        return { exec: async () => ({ stdout: table, stderr: "", code: 0 }), dispose: async () => {} };
    },
});

test("an old host's containers split by owner: this intent's are leftovers on that machine, unowned are reported", async () => {
    const { providers } = createFakeProviders();
    const [scan] = await scanRetiredHosts([oldHost("10.0.0.1")], {
        ssh: executor("forgejo\tforgejo\t\taaa\npostgres\tdb\ttrue\taaa\noutline\twiki\t\t\nkomodo\tkomodo\t\tbbb\n"),
        env: { HOST_SSH_KEY: "key" },
        owner: "aaa",
        providers,
    });
    expect(scan?.error).toBeUndefined();
    expect(scan?.leftovers.map((leftover) => [leftover.id, leftover.protected === true])).toEqual([
        ["forgejo", false],
        ["db", true],
    ]);
    // Deleted on the OLD machine: the entry carries its SSH block.
    expect(scan?.leftovers[0]?.inputs).toMatchObject({ address: "10.0.0.1", sshKey: "key" });
    expect(scan?.unowned).toEqual([{ id: "wiki", type: "outline" }]);
});

test("an old host that cannot be reached, or whose key is not set, is recorded as not scanned rather than clean", async () => {
    const { providers } = createFakeProviders();
    const scans = await scanRetiredHosts([oldHost("10.0.0.66"), oldHost("10.0.0.2")], {
        ssh: executor(""),
        env: {},
        owner: "aaa",
        providers,
    });
    expect(scans.map((scan) => scan.error)).toEqual([
        "reaching it needs HOST_SSH_KEY, which is not set",
        "reaching it needs HOST_SSH_KEY, which is not set",
    ]);
    const [unreachable] = await scanRetiredHosts([oldHost("10.0.0.66")], {
        ssh: executor(""),
        env: { HOST_SSH_KEY: "key" },
        owner: "aaa",
        providers,
    });
    expect(unreachable?.error).toContain("ECONNREFUSED");
});
