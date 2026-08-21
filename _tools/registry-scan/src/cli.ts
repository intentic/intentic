#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REGISTRY_FILE, RegistryFileSchema } from "@intentic/registry";
import { admissionProblems, attestSecurityAudit, needsSecurityAttestation, securityAuditRequest, securityAuditTargets } from "./audit.js";
import { githubReader } from "./github.js";
import { scanSummary, writeScanOutputs } from "./outputs.js";
import { scanRegistry } from "./scan.js";

/* The scan's entry point, run from a checkout of the registry repo itself. Reads the environment, scans, and
 * hands the result to writeScanOutputs; the workflow that calls it only moves the resulting files around. */

const scan = async (): Promise<void> => {
    const token = process.env[`GITHUB_TOKEN`];
    if (token === undefined || token === ``) {
        throw new Error(`GITHUB_TOKEN is required: the search and contents endpoints are rate-limited to nothing without it`);
    }
    // Passed in rather than read from the clock so a re-run against a fixed input produces a fixed output.
    const scannedAt = process.env[`SCANNED_AT`] ?? new Date().toISOString();
    const root = process.env[`REGISTRY_DIR`] ?? process.cwd();

    const file = RegistryFileSchema.parse(JSON.parse(await readFile(join(root, REGISTRY_FILE), "utf8")));
    const result = await scanRegistry(file, githubReader(token), scannedAt);

    await writeScanOutputs(root, file, result);
    process.stdout.write(`${scanSummary(result)}\n`);
};

const option = (args: readonly string[], name: string): string => {
    const at = args.indexOf(name);
    const value = at === -1 ? undefined : args[at + 1];
    if (value === undefined || value === "") {
        throw new Error(`${name} is required`);
    }
    return value;
};

const readRegistry = async (path: string) => RegistryFileSchema.parse(JSON.parse(await readFile(path, "utf8")));

const writeActionOutputs = async (targets: readonly unknown[], needsAttestation: boolean, request: string): Promise<void> => {
    const path = process.env["GITHUB_OUTPUT"];
    if (path === undefined || path === "") {
        return;
    }
    const delimiter = `intentic_${randomUUID()}`;
    await appendFile(
        path,
        `targets=${targets.length}\ntargets-json=${JSON.stringify(targets)}\nneeds-attestation=${needsAttestation}\nrequest<<${delimiter}\n${request}\n${delimiter}\n`,
        "utf8",
    );
};

const prepareAudit = async (args: readonly string[]): Promise<void> => {
    const base = await readRegistry(option(args, "--base"));
    const candidate = await readRegistry(option(args, "--candidate"));
    const targets = securityAuditTargets(base, candidate);
    const problems = admissionProblems(candidate, targets);
    if (problems.length > 0) {
        throw new Error(`registry admission failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    }
    const request = targets.length === 0 ? "" : securityAuditRequest(targets);
    await writeActionOutputs(targets, needsSecurityAttestation(candidate, targets), request);
    process.stdout.write(targets.length === 0 ? "No executable source or review changed.\n" : `${request}\n`);
};

const attestAudit = async (args: readonly string[]): Promise<void> => {
    const base = await readRegistry(option(args, "--base"));
    const candidatePath = option(args, "--candidate");
    const candidate = await readRegistry(candidatePath);
    const targets = securityAuditTargets(base, candidate);
    if (targets.length === 0) {
        throw new Error("there is no changed executable source to attest");
    }
    const reviewedAt = process.env["REVIEWED_AT"] ?? new Date().toISOString();
    const attested = RegistryFileSchema.parse(
        attestSecurityAudit(candidate, targets, option(args, "--run-id"), option(args, "--scan-run-id"), reviewedAt),
    );
    const problems = admissionProblems(attested, []);
    if (problems.length > 0) {
        throw new Error(`attestation did not admit the registry:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    }
    await writeFile(candidatePath, `${JSON.stringify(attested, null, 4)}\n`, "utf8");
};

const [command = "scan", ...args] = process.argv.slice(2);
if (command === "scan") {
    await scan();
} else if (command === "audit") {
    await prepareAudit(args);
} else if (command === "attest") {
    await attestAudit(args);
} else {
    throw new Error(`unknown command ${command}; expected scan, audit, or attest`);
}
