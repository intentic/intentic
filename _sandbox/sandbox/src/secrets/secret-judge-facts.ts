import { unlessAborted } from "@intentic/base/async";
import { normalizeHostPattern, SECRET_HOSTS_MAX } from "@intentic/sandbox-contract/policy/secret-hosts";
import type { Services } from "../composition.js";
import { SecretJudgeFactsError } from "../safety/secret-judge-facts-error.js";
import { gateForName } from "./credential-gates.js";
import { guardForName } from "./guards/host-guards.js";
import { referencedNames } from "./secret-registry.js";
import { commandDestination, namedCommandHosts } from "./secret-destinations.js";

// Keep this budget independent of the program and policy. Whole rows only, with protected/existing names first.
const FACTS_CAP = 4_000;
const HOSTS_CAP = 20;
const HOST_TEXT_CAP = 800;
const OMITTED = "- Additional secret-reference metadata omitted; treat all references as credentials.";
type FactServices = Pick<Services, "secretRegistry" | "hostGuards" | "credentialGates" | "keyringLink">;

const hostList = (hosts: readonly string[]) => {
    const kept: string[] = [];
    let size = 0;
    for (const host of hosts) {
        size += JSON.stringify(host).length + 1;
        if (kept.length === HOSTS_CAP || size > HOST_TEXT_CAP) { break; }
        kept.push(host);
    }
    return { hosts: kept, additionalHosts: hosts.length - kept.length };
};

const metadata = async (services: FactServices, names: readonly string[]) => {
    const known = services.secretRegistry.names?.();
    if (services.hostGuards.metadata === undefined) {
        throw new Error("Secret host-guard metadata is unavailable");
    }
    const [guards, gates, pointers] = await Promise.all([
        services.hostGuards.metadata(),
        services.credentialGates.list(),
        Promise.all(names.map((name) => known?.includes(name) === true ? undefined : services.keyringLink.pointer(name))),
    ]);
    return names.map((name, index) => {
        const device = pointers[index];
        const hostGuard = device === undefined ? guardForName(guards, name) : {
            guard: true,
            // Match device-secrets.ts enforcement: invalid patterns are dropped, then the same limit applies.
            hosts: device.pointer.hosts.flatMap((host) => normalizeHostPattern(host) ?? []).slice(0, SECRET_HOSTS_MAX),
        };
        const gated = gateForName(gates, name) !== undefined;
        const exists = known?.includes(name) === true || device !== undefined ? true : known === undefined ? "unknown" : false;
        return {
            priority: Number(hostGuard?.guard === true || gated) * 2 + Number(exists === true),
            line: `- Secret ${JSON.stringify(name)}: ${JSON.stringify({
                exists,
                hostGuard: hostGuard?.guard ?? (name.includes("/") ? "unknown" : false),
                ...hostList(hostGuard?.hosts ?? []),
                gated,
                keyrings: device === undefined ? [] : [device.machine],
            })}`,
        };
    });
};

// No value-bearing registry call or keyring release here. Abort the wait even if a metadata store ignores the signal.
export const secretJudgeFacts = async (services: FactServices, program: string, signal: AbortSignal): Promise<readonly string[]> => {
    const names = referencedNames(program);
    if (names.length === 0) { return []; }
    try {
        signal.throwIfAborted();
        const rows = await unlessAborted(metadata(services, names), signal, undefined);
        if (rows === undefined) { throw new Error("Secret metadata deadline expired"); }
        const lines = [
            "- Secret references are replaced with real credential values before execution, including inside quotes, JSON, heredocs and documentation-like text. Judge where those values go, not the stated purpose.",
            "- Existence reflects the last registry names snapshot and keyring pointers; missing or unknown names still count as credentials because stores may have changed.",
        ];
        const hosts = `- Hosts named by the command: ${JSON.stringify(hostList(namedCommandHosts(program)))}. Destination analysis: ${commandDestination(program).certain ? "readable" : "unreadable; named hosts may be incomplete"}.`;
        let remaining = FACTS_CAP - lines.join("\n").length - hosts.length - OMITTED.length - 3;
        let omitted = false;
        for (const { line } of rows.sort((left, right) => right.priority - left.priority)) {
            if (line.length + 1 > remaining) { omitted = true; continue; }
            lines.push(line);
            remaining -= line.length + 1;
        }
        lines.push(hosts);
        if (omitted) { lines.push(OMITTED); }
        return lines;
    } catch (error) {
        throw new SecretJudgeFactsError("Secret-reference metadata could not be collected; no model verdict was obtained", { cause: error });
    }
};
