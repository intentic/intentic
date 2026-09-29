import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { type Capability, parseHostConnection, SyncEnrollmentAnswerSchema } from "@intentic/sandbox-contract";
import { stubEnv } from "@intentic/testing/bun";
import { createApp } from "../app.js";
import type { Services } from "../composition.js";
import { testConfig } from "../testing.js";
import { sshdHostKeyPath } from "./desktop-sync-ssh.js";
import { tempWorkspace } from "../harness/route-fakes.testing.js";
import { fakeFiles } from "../workspace/workspace-slice.testing.js";
import { services } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../capabilities/capabilities-slice.testing.js";
import { rejectForbidden } from "../harness/route-client.testing.js";

// One machine can hold two doors and only one of them is ever drawn: the ssh key desktop sync rides, and a device
// enrollment, which no screen lists once its capability card is gone. Revoking a machine's access has to end both, or
// the removal the owner just pressed leaves a live credential behind that nothing can withdraw.

// Enrollment state as the peer store keeps it, narrowed to the verbs this route reaches for.
const hostDoor = (enrolled: string[]) => ({
    ids: enrolled,
    store: unstubbed<Services["hosts"]>("hosts", {
        enrolled: async (id: string) => enrolled.includes(id),
        // A card's enrollments go in one write: every connection whose key names the card.
        revokeCard: async (card: string) => {
            const dropped = enrolled.filter((id) => parseHostConnection(id).card === card);
            enrolled.splice(0, enrolled.length, ...enrolled.filter((id) => parseHostConnection(id).card !== card));
            return dropped;
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

// Enrollment hands the machine the key this sandbox's sshd presents, so the machine pins it in known_hosts rather than
// trusting whichever key answers its first connection.
const enrolling = (historyRoot: string) => {
    stubEnv("HOME", mkdtempSync(join(tmpdir(), "sync-enroll-home-")));
    const svc = services({ config: { ...testConfig, historyRoot } });
    const served = createApp(svc);
    return async (): Promise<Response> =>
        served.request("/system/authorized-key", {
            method: "POST",
            headers: { "content-type": "application/json", "x-intentic-pair": svc.syncPairings.mint("sync").token },
            body: JSON.stringify({ key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILaptopLaptopLaptop laptop" }),
        });
};

test("an enrollment answers with the sshd host key off the history volume, its comment dropped", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "sync-enroll-history-"));
    // As docker-entrypoint.sh's ssh-keygen writes it: type, body, comment, newline.
    mkdirSync(dirname(sshdHostKeyPath(historyRoot)), { recursive: true });
    writeFileSync(sshdHostKeyPath(historyRoot), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISandboxHostKeyBody intentic-sandbox\n");

    const response = await enrolling(historyRoot)();

    expect(response.status).toBe(200);
    expect(SyncEnrollmentAnswerSchema.parse(await response.json())).toStrictEqual({
        ok: true,
        syncToken: expect.any(String),
        mode: "sync",
        hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISandboxHostKeyBody",
    });
});

test("a sandbox with no sshd host key still enrolls, and hands over no key for the machine to pin", async () => {
    const response = await enrolling(mkdtempSync(join(tmpdir(), "sync-enroll-history-")))();

    expect(response.status).toBe(200);
    expect(SyncEnrollmentAnswerSchema.parse(await response.json())).toStrictEqual({ ok: true, syncToken: expect.any(String), mode: "sync" });
});

test("a host key file that holds no key line is not handed over", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "sync-enroll-history-"));
    mkdirSync(dirname(sshdHostKeyPath(historyRoot)), { recursive: true });
    writeFileSync(sshdHostKeyPath(historyRoot), "-----BEGIN OPENSSH PRIVATE KEY-----\n");

    const response = await enrolling(historyRoot)();

    expect(SyncEnrollmentAnswerSchema.parse(await response.json())).toStrictEqual({ ok: true, syncToken: expect.any(String), mode: "sync" });
});

// A machine's setup goes on past its enrollment (the folder, the sync engine, the SSH probe) and can fail there; its
// retry enrolls again with the same pairing. Spent on first use, every retry failed at enrollment instead, the
// desktop app's Try again included. The pairing stays good for the key that redeemed it, and for no other.
describe("a pairing redeemed once", () => {
    const LAPTOP = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILaptopLaptopLaptop laptop";
    const STRANGER = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStrangerStranger stranger";
    const door = () => {
        stubEnv("HOME", mkdtempSync(join(tmpdir(), "sync-reenroll-home-")));
        // Not the owner: past the pairing, nobody gets in on a Google token here.
        const svc = services({
            config: { ...testConfig, historyRoot: mkdtempSync(join(tmpdir(), "sync-reenroll-history-")) },
            auth: { authorize: rejectForbidden, authorizeOwner: rejectForbidden },
        });
        const served = createApp(svc);
        const pair = svc.syncPairings.mint("mirror").token;
        const enroll = async (key: string): Promise<Response> =>
            served.request("/system/authorized-key", {
                method: "POST",
                headers: { "content-type": "application/json", "x-intentic-pair": pair },
                body: JSON.stringify({ key }),
            });
        return { svc, pair, enroll, served };
    };

    it("enrolls the same machine key again, under the mode the pairing granted", async () => {
        const { enroll } = door();
        expect((await enroll(LAPTOP)).status).toBe(200);

        const again = await enroll(LAPTOP);

        expect(again.status).toBe(200);
        expect(SyncEnrollmentAnswerSchema.parse(await again.json())).toMatchObject({ ok: true, mode: "mirror" });
    });

    // Revoked minutes after enrolling: the retry window must not let the machine walk back in with the same pairing.
    it("is spent for the same key too once that machine's enrollment is revoked", async () => {
        const { enroll, served } = door();
        const first = SyncEnrollmentAnswerSchema.parse(await (await enroll(LAPTOP)).json());
        const revoked = await served.request("/system/authorized-key", { method: "DELETE", headers: { "x-intentic-sync": first.syncToken ?? "" } });
        expect(revoked.status).toBe(200);

        expect((await enroll(LAPTOP)).status).toBe(403);
    });

    it("is spent for any other key", async () => {
        const { enroll } = door();
        expect((await enroll(LAPTOP)).status).toBe(200);

        expect((await enroll(STRANGER)).status).toBe(403);
    });

    it("is spent for the same key too once the pairing's lifetime has passed", async () => {
        const { enroll } = door();
        expect((await enroll(LAPTOP)).status).toBe(200);
        const later = Date.now() + 10 * 60 * 1000 + 1;
        const clock = jest.spyOn(Date, "now").mockReturnValue(later);
        try {
            expect((await enroll(LAPTOP)).status).toBe(403);
        } finally {
            clock.mockRestore();
        }
    });
});
