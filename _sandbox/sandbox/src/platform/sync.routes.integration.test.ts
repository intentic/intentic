import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Capability } from "@intentic/sandbox-contract";
import { stubEnv } from "@intentic/testing/bun";
import { createApp } from "../app.js";
import type { Services } from "../composition.js";
import { fakeFiles, tempWorkspace } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../harness/route-stores.testing.js";

// One machine can hold two doors and only one of them is ever drawn: the ssh key desktop sync rides, and a device
// enrollment, which no screen lists once its capability card is gone. Revoking a machine's access has to end both, or
// the removal the owner just pressed leaves a live credential behind that nothing can withdraw.

// Enrollment state as the peer store keeps it, narrowed to the verbs this route reaches for.
const hostDoor = (enrolled: string[]) => ({
    ids: enrolled,
    store: unstubbed<Services["hosts"]>("hosts", {
        enrolled: async (id: string) => enrolled.includes(id),
        list: async () => enrolled.map((id) => ({ id }) as never),
        revoke: async (id: string) => {
            const at = enrolled.indexOf(id);
            if (at !== -1) {
                enrolled.splice(at, 1);
            }
            return at !== -1;
        },
    }),
});

const linux = (id: string): Capability => ({ id, kind: "device", config: { platform: "linux" } }) as unknown as Capability;

const app = (enrolled: string[], cards: Capability[]) => {
    // authorized_keys is derived from the store on every write; HOME stays a temp dir so no suite touches the real one.
    stubEnv("HOME", mkdtempSync(join(tmpdir(), "sync-revoke-")));
    const cut: string[] = [];
    const door = hostDoor(enrolled);
    return {
        cut,
        app: createApp(
            services({
                workspace: tempWorkspace([]),
                files: fakeFiles(),
                capabilities: memoryCapabilitiesStore(cards),
                hosts: door.store,
                hostHub: unstubbed<Services["hostHub"]>("hostHub", { disconnect: (id: string) => void cut.push(id) }),
            }),
        ),
    };
};

const revoke = async (built: ReturnType<typeof app>, machine: string): Promise<Response> =>
    built.app.request(`/system/authorized-key/${machine}`, { method: "DELETE" });

test("a device enrollment no card holds is dropped with the machine, socket cut, even with no ssh key to revoke", async () => {
    const enrolled = ["ghost", "ghost::wsl:archlinux"];
    const built = app(enrolled, []);

    const response = await revoke(built, "ghost");

    expect(response.status).toBe(200);
    expect(enrolled).toEqual([]);
    expect(built.cut).toEqual(["ghost", "ghost::wsl:archlinux"]);
});

test("a device its card still grants keeps its enrollment: that grant is the card's to withdraw", async () => {
    const enrolled = ["laptop"];
    const built = app(enrolled, [linux("laptop")]);

    const response = await revoke(built, "laptop");

    expect(response.status).toBe(404);
    expect(enrolled).toEqual(["laptop"]);
    expect(built.cut).toEqual([]);
});

test("a name at neither door is still a 404, so a mistyped machine reads as one", async () => {
    const built = app(["ghost"], []);

    expect((await revoke(built, "typo")).status).toBe(404);
});
