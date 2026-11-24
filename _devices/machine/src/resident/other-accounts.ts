import { basename } from "node:path";
import { explain } from "@intentic/local-agent";
import { execBounded } from "@intentic/base/process";

/* ANOTHER ACCOUNT'S AGENT ON THIS COMPUTER (2026-11-24). The agent is one per computer: its pidfile, its machine-id and
   its links all live under the home of the account that installed it, so the singleton they make is one per home. A
   connect one-liner pasted as root after a user had installed (or the other way round) put a second agent in the
   second home: on inwin, radarsu's (linked to one sandbox) and root's (linked to another) ran side by side for days,
   each its own machine-id, so each sandbox saw a different computer named "inwin", each running its own remoted, ic
   rounds and egress follower. Nothing either agent held could see the other. The process table can: an agent runs as
   `<home>/.intentic/machine/bin/intentic-machine run …`, whatever account owns it. Setup refuses beside one
   (install.ts), and upkeep reports one on every pass (upkeep/other-account.ts).

   Windows is left out: there the agent is per user by its login entry, and the boot task's agent is the same
   account's (autostart/before-sign-in.ts). A WSL distro's agent is in a process table of its own. */

export interface OtherAgent {
    readonly pid: number;
    readonly uid: number;
    // The home it runs from: `<home>/.intentic/machine` is its state.
    readonly home: string;
}

const AGENT_RUN = /^(\/.*?)\/\.intentic\/machine\/bin\/intentic-machine run(?:\s|$)/u;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/u;

// The resident agents in `ps -A -o pid=,uid=,args=` that another account runs. Pure.
export const otherAccountAgents = (psOutput: string, ownUid: number): readonly OtherAgent[] =>
    psOutput.split("\n").flatMap((line) => {
        const row = PS_LINE.exec(line);
        const home = row === null ? undefined : AGENT_RUN.exec(row[3] ?? "")?.[1];
        if (row === null || home === undefined) {
            return [];
        }
        const uid = Number(row[2]);
        return uid === ownUid ? [] : [{ pid: Number(row[1]), uid, home }];
    });

// The live ones, read from this computer's process table; none where it cannot be read, since this only ever warns
// or refuses and must not stop a setup for want of `ps`.
export const findOtherAccountAgents = async (platform: NodeJS.Platform = process.platform): Promise<readonly OtherAgent[]> => {
    const ownUid = process.getuid?.();
    if (platform === "win32" || ownUid === undefined) {
        return [];
    }
    // allow(silent-catch): a process table that cannot be read shows no other agent, the answer before this check existed
    const listed = await execBounded("ps", ["-A", "-o", "pid=,uid=,args="], { timeoutMs: 15_000 }).catch(() => ({ stdout: "" }));
    return otherAccountAgents(listed.stdout, ownUid);
};

// The account's name for the sentence; its home's last part where `id` will not say. Best-effort.
export const accountName = async (agent: OtherAgent): Promise<string> => {
    // allow(silent-catch): a name is for the sentence alone
    const named = (await execBounded("id", ["-nu", String(agent.uid)], { timeoutMs: 5_000 }).catch(() => ({ stdout: "" }))).stdout.trim();
    return named === "" ? basename(agent.home) : named;
};

// One line naming an agent, for upkeep and the refusal alike. Pure.
export const otherAgentLine = (agent: OtherAgent, account: string): string =>
    `another account on this computer, ${account}, runs its own intentic agent (pid ${agent.pid}, from ${agent.home}/.intentic/machine)`;

// The way out, as the account it belongs to: run the one-liner as that account, or remove that agent. Pure.
export const otherAgentFix = (agent: OtherAgent, account: string): string => {
    const as = account === "root" ? "with sudo" : `as ${account} (sudo -iu ${account})`;
    return `run the same command ${as}, so the one agent this computer has links this sandbox too; or remove that agent first, ${as}: ${agent.home}/.intentic/machine/bin/intentic-machine uninstall`;
};

// Set to 1 to install beside another account's agent anyway: a computer two people share on purpose.
export const ALLOW_SECOND_AGENT_ENV = "INTENTIC_SECOND_AGENT";

// What setup runs before it enrolls anything: a second agent is a second computer to every sandbox, so it is refused
// with who holds this one, while the pairing token is still unspent.
export const refuseBesideOtherAccount = async (
    notConnected: string,
    env: Record<string, string | undefined> = process.env,
    find: () => Promise<readonly OtherAgent[]> = findOtherAccountAgents,
): Promise<void> => {
    if (env[ALLOW_SECOND_AGENT_ENV] === "1") {
        return;
    }
    const [agent] = await find();
    if (agent === undefined) {
        return;
    }
    const account = await accountName(agent);
    throw new Error(
        explain(
            notConnected,
            `${otherAgentLine(agent, account)}, and a second one here would be a second computer to your sandboxes.`,
            `${otherAgentFix(agent, account)}. To keep both on purpose, run it again with ${ALLOW_SECOND_AGENT_ENV}=1.`,
        ),
    );
};
