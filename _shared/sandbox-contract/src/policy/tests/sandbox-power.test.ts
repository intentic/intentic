import { isOsPower, managesSandbox, mayReachSandbox, SANDBOX_POWER_DOING, type SandboxPowerCommand, sandboxPowerCommands } from "../sandbox-power.js";

const OWN = { slug: "work", container: "intentic-sandbox-work" };
const PREFIX = "intentic-sandbox-";

// What a command aims at, without the spans: the verb, whether it ends a running sandbox's turns, and who it names.
const aimOf = (hit: SandboxPowerCommand | undefined) => hit && { via: hit.via, op: hit.op, stops: hit.stops, targets: hit.targets, unnamed: hit.unnamed };
const first = (command: string) => aimOf(sandboxPowerCommands(command)[0]);

describe("ic sandbox", () => {
    test("reads every verb that ends a running sandbox's turns, with the slug it names", () => {
        expect(first("ic sandbox restart work")).toEqual({ via: "ic", op: "restart", stops: true, targets: ["work"], unnamed: false });
        expect(first("ic sandbox stop work")).toEqual({ via: "ic", op: "stop", stops: true, targets: ["work"], unnamed: false });
        expect(first("ic sandbox rm work")).toEqual({ via: "ic", op: "remove", stops: true, targets: ["work"], unnamed: false });
        expect(first("ic sandbox remove work -y")).toEqual({ via: "ic", op: "remove", stops: true, targets: ["work"], unnamed: false });
        expect(first("ic sandbox rebuild work 3f2a")).toEqual({ via: "ic", op: "rebuild", stops: true, targets: ["work", "3f2a"], unnamed: false });
        expect(first("ic sandbox update work --no-resume")).toEqual({ via: "ic", op: "update", stops: true, targets: ["work"], unnamed: false });
        expect(first("ic sandbox rollback work --to 1.315.0")).toEqual({ via: "ic", op: "rollback", stops: true, targets: ["work"], unnamed: false });
        expect(first("ic sandbox sleep work")).toEqual({ via: "ic", op: "sleep", stops: true, targets: ["work"], unnamed: false });
        expect(first("ic sandbox dev work")).toEqual({ via: "ic", op: "dev", stops: true, targets: ["work"], unnamed: false });
    });

    test("a start, a download and a resource ask saved for later are managing the sandbox but ending nothing", () => {
        expect(first("ic sandbox start work")).toEqual({ via: "ic", op: "start", stops: false, targets: ["work"], unnamed: false });
        expect(first("ic sandbox prepare work --auto")).toEqual({ via: "ic", op: "prepare", stops: false, targets: ["work"], unnamed: false });
        expect(first("ic sandbox reshape work --memory 12g --later")?.stops).toBe(false);
        expect(first("ic sandbox reshape work --forget")?.stops).toBe(false);
        expect(first("ic sandbox shape work --set cpus=4 --when next-restart")?.stops).toBe(false);
        expect(first("ic sandbox shape work --set cpus=4 --when nextRestart")?.stops).toBe(false);
    });

    test("a resource change applied now restarts, and so does a bare reshape, which applies what was saved", () => {
        expect(first("ic sandbox reshape work --memory 12g")).toEqual({ via: "ic", op: "resize", stops: true, targets: ["work"], unnamed: false });
        expect(first("ic sandbox reshape work")?.stops).toBe(true);
        expect(first("ic sandbox shape work --set cpus=4 --when now")).toEqual({ via: "ic", op: "resize", stops: true, targets: ["work"], unnamed: false });
        expect(first("ic sandbox shape work --when=now --set cpus=4")?.stops).toBe(true);
    });

    test("a flag's value is not a slug, so a command naming no sandbox reads as naming none", () => {
        expect(first("ic sandbox update --channel stable")).toEqual({ via: "ic", op: "update", stops: true, targets: [], unnamed: true });
        expect(first("ic sandbox rollback --to 1.315.0")).toEqual({ via: "ic", op: "rollback", stops: true, targets: [], unnamed: true });
        expect(first("ic sandbox restart")).toEqual({ via: "ic", op: "restart", stops: true, targets: [], unnamed: true });
        expect(first("ic sandbox restart 2>&1")?.unnamed).toBe(true);
        expect(first("ic sandbox remove --all -y")?.unnamed).toBe(true);
    });

    test("a backup restored into a sandbox stops it; restored to a folder it touches none", () => {
        expect(first("ic sandbox backup-restore work --snapshot latest --into work -y")).toEqual({
            via: "ic",
            op: "restore",
            stops: true,
            targets: ["work"],
            unnamed: false,
        });
        expect(first("ic sandbox backup-restore work --snapshot latest --into other")?.targets).toEqual(["other"]);
        expect(first("ic sandbox backup-restore work --snapshot latest --to /tmp/look")?.stops).toBe(false);
    });

    test("reinstalling over a sandbox ends it, and names no slug the command line shows", () => {
        expect(first("ic sandbox connect --replace -y abc123")).toEqual({ via: "ic", op: "connect", stops: true, targets: [], unnamed: true });
        expect(first("ic sandbox connect -y abc123")?.stops).toBe(false);
    });

    test("reads the program however a shell is told to find it", () => {
        for (const command of [
            "ic.exe sandbox restart work",
            "& 'C:\\Users\\radar\\.intentic\\bin\\ic.exe' sandbox restart work",
            '& "C:\\Users\\radar\\.intentic\\bin\\ic.exe" sandbox restart work',
            "~/.intentic/bin/ic sandbox restart work",
            "sudo ic sandbox restart work",
            "cd /tmp && ic sandbox restart work",
            "wsl -d archlinux -- ic sandbox restart work",
            "IC SANDBOX RESTART work",
        ]) {
            expect(first(command), command).toMatchObject({ via: "ic", op: "restart", targets: ["work"] });
        }
    });

    test("leaves alone what only reads, and words that merely end in ic", () => {
        for (const command of [
            "ic sandbox list --json",
            "ic sandbox logs work --tail 50",
            "ic sandbox doctor work",
            "ic sandbox versions work",
            "intentic sandbox restart work",
            "magic sandbox restart work",
            "ic runner remove build",
            "git commit -m 'document how ic works'",
        ]) {
            expect(sandboxPowerCommands(command), command).toEqual([]);
        }
    });

    test("stops reading at the end of the simple command, so a later command's words are not this one's operands", () => {
        expect(first("ic sandbox restart work; echo done")?.targets).toEqual(["work"]);
        expect(first("ic sandbox restart | tee log")?.unnamed).toBe(true);
        expect(first("ic sandbox restart work && ic sandbox start other")?.targets).toEqual(["work"]);
        expect(sandboxPowerCommands("ic sandbox restart work && ic sandbox start other").map((hit) => hit.targets)).toEqual([["work"], ["other"]]);
    });

    test("marks a command that only appears as text as not live", () => {
        expect(sandboxPowerCommands("echo 'ic sandbox restart work'")[0]?.live).toBe(false);
        expect(sandboxPowerCommands("# ic sandbox restart work")[0]?.live).toBe(false);
        expect(sandboxPowerCommands("ic sandbox restart work")[0]?.live).toBe(true);
        expect(sandboxPowerCommands("ic sandbox restart work")[0]?.span).toEqual({ start: 0, end: "ic sandbox restart".length });
    });
});

describe("docker", () => {
    test("reads a stop, kill, restart or remove of a container, with the names it gives", () => {
        expect(first("docker stop intentic-sandbox-work")).toEqual({ via: "docker", op: "stop", stops: true, targets: ["intentic-sandbox-work"], unnamed: false });
        expect(first("docker kill intentic-sandbox-work")?.op).toBe("stop");
        expect(first("docker restart intentic-sandbox-work")?.op).toBe("restart");
        expect(first("docker rm -f intentic-sandbox-work")).toEqual({ via: "docker", op: "remove", stops: true, targets: ["intentic-sandbox-work"], unnamed: false });
        expect(first("docker container stop -t 60 a b")).toEqual({ via: "docker", op: "stop", stops: true, targets: ["a", "b"], unnamed: false });
        expect(first("docker.exe stop a")?.targets).toEqual(["a"]);
        expect(first("podman rm a")?.via).toBe("docker");
    });

    test("leaves alone docker that stops nothing", () => {
        for (const command of ["docker ps", "docker logs intentic-sandbox-work", "docker start intentic-sandbox-work", "docker exec c kill -9 1", "docker compose stop"]) {
            expect(sandboxPowerCommands(command), command).toEqual([]);
        }
    });

    test("a stop fed from a pipe names nothing", () => {
        expect(first("docker ps -q | xargs docker stop")).toEqual({ via: "docker", op: "stop", stops: true, targets: [], unnamed: true });
    });
});

// On Intentic OS the machine's own OS is changed through `ic os` (and bootc under it): what reboots it stops every
// sandbox on it, and what only stages for the next boot stops none, like a sandbox's prepare.
describe("ic os and bootc", () => {
    const WHOLE_MACHINE = { targets: [], unnamed: true };

    test("reads every verb that changes what the machine boots, as the whole machine's", () => {
        expect(first("ic os update")).toEqual({ via: "ic", op: "os-update", stops: false, ...WHOLE_MACHINE });
        expect(first("ic os update --apply")).toEqual({ via: "ic", op: "os-update", stops: true, ...WHOLE_MACHINE });
        expect(first("ic os rollback")).toEqual({ via: "ic", op: "os-rollback", stops: false, ...WHOLE_MACHINE });
        expect(first("ic os rollback --apply")).toEqual({ via: "ic", op: "os-rollback", stops: true, ...WHOLE_MACHINE });
        expect(first("ic os reboot")).toEqual({ via: "ic", op: "os-reboot", stops: true, ...WHOLE_MACHINE });
        // The channel is the verb's operand, not a sandbox it names.
        expect(first("ic os channel beta")).toEqual({ via: "ic", op: "os-channel", stops: false, ...WHOLE_MACHINE });
    });

    test("reads bootc's own spelling of the same ops", () => {
        expect(first("sudo bootc upgrade")).toEqual({ via: "bootc", op: "os-update", stops: false, ...WHOLE_MACHINE });
        expect(first("sudo -n /usr/bin/bootc upgrade --apply")).toEqual({ via: "bootc", op: "os-update", stops: true, ...WHOLE_MACHINE });
        expect(first("bootc switch ghcr.io/intentic/os:beta")).toEqual({ via: "bootc", op: "os-channel", stops: false, ...WHOLE_MACHINE });
        expect(first("bootc switch --apply --transport registry ghcr.io/intentic/os:beta")?.stops).toBe(true);
        expect(first("bootc rollback")).toEqual({ via: "bootc", op: "os-rollback", stops: false, ...WHOLE_MACHINE });
        expect(first("bootc rollback --apply")?.stops).toBe(true);
    });

    test("leaves alone what only reads or sets up", () => {
        for (const command of [
            "ic os status --json",
            "ic os update --check --json",
            "ic os health --wait 600",
            "ic os record",
            "ic os pair",
            "bootc status --json",
            "bootc upgrade --check",
            "magic os reboot",
            "echo cosmic os update",
        ]) {
            expect(sandboxPowerCommands(command), command).toEqual([]);
        }
    });

    test("a reboot may reach this sandbox and is the switch's, wherever this sandbox runs", () => {
        const reboot = sandboxPowerCommands("ic os reboot")[0];
        expect(reboot !== undefined && mayReachSandbox(reboot, OWN)).toBe(true);
        expect(reboot !== undefined && managesSandbox(reboot, PREFIX)).toBe(true);
        expect(reboot !== undefined && isOsPower(reboot)).toBe(true);
        const staged = sandboxPowerCommands("sudo bootc upgrade")[0];
        expect(staged !== undefined && managesSandbox(staged, PREFIX)).toBe(true);
        expect(isOsPower({ op: "restart" })).toBe(false);
    });

    test("is found beside a sandbox verb in the same line, in the order written, and quoted it is not live", () => {
        expect(sandboxPowerCommands("ic sandbox stop work && ic os reboot").map((hit) => hit.op)).toEqual(["stop", "os-reboot"]);
        expect(sandboxPowerCommands("echo 'ic os reboot'")[0]?.live).toBe(false);
        expect(sandboxPowerCommands("ic os reboot")[0]?.span).toEqual({ start: 0, end: "ic os reboot".length });
    });
});

describe("whether a command may reach this sandbox", () => {
    const reaches = (command: string): boolean => sandboxPowerCommands(command).some((hit) => mayReachSandbox(hit, OWN));

    test("names it by slug or by container", () => {
        expect(reaches("ic sandbox restart work")).toBe(true);
        expect(reaches("docker stop intentic-sandbox-work")).toBe(true);
        // docker knows no such container, but a card for a mistaken match costs less than a fleet cut unasked
        expect(reaches("docker stop work")).toBe(true);
    });

    test("names none, or something that is only worked out when it runs", () => {
        expect(reaches("ic sandbox update")).toBe(true);
        expect(reaches("ic sandbox remove --all")).toBe(true);
        expect(reaches("docker stop $(docker ps -q)")).toBe(true);
        expect(reaches('docker stop "$SANDBOX"')).toBe(true);
        expect(reaches("docker stop (docker ps -q)")).toBe(true);
        expect(reaches("docker rm intentic-sandbox-*")).toBe(true);
        expect(reaches("ic sandbox restart %NAME%")).toBe(true);
    });

    test("names another sandbox, or another container", () => {
        expect(reaches("ic sandbox restart other")).toBe(false);
        expect(reaches("ic sandbox rebuild other 3f2a")).toBe(false);
        expect(reaches("docker stop intentic-sandbox-other")).toBe(false);
        expect(reaches("docker restart postgres")).toBe(false);
        expect(reaches("ic sandbox update --channel stable other")).toBe(false);
    });
});

describe("whether a command manages a sandbox the switch covers", () => {
    const manages = (command: string): boolean => sandboxPowerCommands(command).some((hit) => managesSandbox(hit, PREFIX));

    test("any ic sandbox verb, whichever sandbox it names", () => {
        expect(manages("ic sandbox restart other")).toBe(true);
        expect(manages("ic sandbox start other")).toBe(true);
        expect(manages("ic sandbox update")).toBe(true);
    });

    test("docker only for a container that is a sandbox's, since the device cannot know a name worked out at run time", () => {
        expect(manages("docker stop intentic-sandbox-other")).toBe(true);
        expect(manages("docker rm -f intentic-sandbox-tunnel-abc")).toBe(true);
        expect(manages("docker restart postgres")).toBe(false);
        expect(manages("docker stop $(docker ps -q)")).toBe(false);
    });
});

test("every operation has the owner's word for it", () => {
    expect(SANDBOX_POWER_DOING.restart).toBe("Restart");
    expect(SANDBOX_POWER_DOING.resize).toBe("Restart with new resources");
    expect(SANDBOX_POWER_DOING.rollback).toBe("Roll back");
    expect(`${SANDBOX_POWER_DOING["os-reboot"]} this sandbox now?`).toBe("Reboot the machine running this sandbox now?");
});
