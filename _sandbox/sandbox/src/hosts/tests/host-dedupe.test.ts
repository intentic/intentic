import { unstubbed } from "@intentic/testing";
import { derivedMachineId, hostConnectionKey } from "@intentic/sandbox-contract/schemas/hosts";
import type { Services } from "../../composition.js";
import { revokeSuperseded, sharedIdentities, supersededEnrollments } from "../host-dedupe.js";

// (2026-10-18) An older key of the same computer's same OS install is one nothing can present again, since the machine
// agent keeps one link per sandbox: dropped once a newer one connects, and never one in use or one whose identity is a
// placeholder.

const ROG = "m-f9491b45-2639-4a69-9e4e-c4697c0403d6";
const OMEN = "m-2c5f01f1-cc0e-42c6-8742-6ddc6b807045";

const entry = (id: string, machineId: string, environment = "native") => ({ id, card: id.split("::")[0] ?? id, machineId, environment });
const nobody = (): boolean => false;
const only =
    (...ids: string[]) =>
    (id: string): boolean =>
        ids.includes(id);

test("drops the older key of a computer re-paired under a new name once the new one connects", () => {
    // Oldest first, as the store lists them: rog's Windows side paired as "radarsu-rog", then again as "rog".
    const enrolled = [entry("radarsu-rog", ROG), entry(hostConnectionKey("rog", "wsl:archlinux"), ROG, "wsl:archlinux"), entry("rog", ROG)];
    const superseded = supersededEnrollments(enrolled, only("rog"), "rog");
    expect(superseded.map(({ stale, by }) => [stale.id, by.id])).toEqual([["radarsu-rog", "rog"]]);
});

test("keeps an older key that is connected right now, and reports the two as one identity", () => {
    const enrolled = [entry("rog-image", ROG), entry("rog", ROG), entry("omen", OMEN)];
    const online = only("rog-image", "rog", "omen");
    expect(supersededEnrollments(enrolled, online, "rog")).toEqual([]);
    expect(sharedIdentities(enrolled, online)).toEqual([
        {
            machineId: ROG,
            connections: [
                { id: "rog-image", card: "rog-image", environment: "native" },
                { id: "rog", card: "rog", environment: "native" },
            ],
        },
    ]);
});

test("never touches a key whose machine id is a placeholder from before its agent reported one", () => {
    const enrolled = [entry("radarsu-rog", derivedMachineId("radarsu-rog")), entry("rog", ROG)];
    expect(supersededEnrollments(enrolled, only("rog"), "rog")).toEqual([]);
    expect(supersededEnrollments(enrolled, nobody)).toEqual([]);
});

test("leaves a newer key alone when an older one of the same computer connects", () => {
    // Not the overwrite a re-pairing does: an older key presenting itself while a newer exists is a copy or a second
    // address, so nothing is provably dead.
    const enrolled = [entry("rog", ROG), entry("rog-again", ROG)];
    expect(supersededEnrollments(enrolled, only("rog"), "rog")).toEqual([]);
});

test("keeps each OS install of one computer: a distro is not a duplicate of its Windows side", () => {
    const enrolled = [entry("rog", ROG), entry(hostConnectionKey("rog", "wsl:archlinux"), ROG, "wsl:archlinux")];
    expect(supersededEnrollments(enrolled, nobody)).toEqual([]);
    expect(supersededEnrollments(enrolled, only("rog"), "rog")).toEqual([]);
});

test("at boot keeps the newest key of each machine environment and drops the ones before it", () => {
    const distro = (card: string): string => hostConnectionKey(card, "wsl:archlinux");
    const enrolled = [
        entry("desk", ROG),
        entry(distro("desk"), ROG, "wsl:archlinux"),
        entry("omen", OMEN),
        entry("rog", ROG),
        entry(distro("rog"), ROG, "wsl:archlinux"),
    ];
    expect(supersededEnrollments(enrolled, nobody).map(({ stale, by }) => [stale.id, by.id])).toEqual([
        ["desk", "rog"],
        [distro("desk"), distro("rog")],
    ]);
});

test("revokes through the store, asks the hub again before each one, and logs what replaced it", async () => {
    const records = [entry("old-a", ROG), entry("old-b", ROG), entry("rog", ROG)];
    const revoked: string[] = [];
    const logged: object[] = [];
    // `old-b` dials in between the list being read and its turn to go: it is in use, so it stays.
    let asked = 0;
    const services = {
        hosts: unstubbed<Services["hosts"]>("hosts", {
            list: async () => records,
            revoke: async (id) => {
                revoked.push(id);
                return true;
            },
        }),
        hostHub: unstubbed<Services["hostHub"]>("hostHub", {
            online: (id) => {
                asked += 1;
                return id === "rog" || (id === "old-b" && asked > 2);
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", { info: (data: object) => void logged.push(data) }),
    };
    expect(await revokeSuperseded(services, "rog")).toEqual(["old-a"]);
    expect(revoked).toEqual(["old-a"]);
    expect(logged).toEqual([{ revoked: "old-a", card: "old-a", supersededBy: "rog", machineId: ROG, environment: "native" }]);
});
