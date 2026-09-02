import { errorMessage } from "@intentic/base/errors";
import type { SshExecutor, SshSession, SshTarget } from "./ssh.js";

// One SSH sweep per host after a readiness timeout, so a field failure self-explains instead of ending in a
// bare "timed out": is the container running, what did it log, is anything listening on the gated port, and
// which addresses the host actually holds (the discovered internalIp may not be reachable even from the host
// itself). Renders a plain string for the CLI to log before rethrowing the timeout. Never throws, a host
// that cannot be reached over SSH degrades to a single line so the sweep still reports the remaining hosts.
export const readinessDiagnostics = async (
    targets: readonly SshTarget[],
    executor: SshExecutor,
    failure: { readonly id: string; readonly url: string },
): Promise<string> => {
    const sections = await Promise.all(targets.map((target) => diagnoseHost(target, executor, failure)));
    return sections.join("\n");
};

const diagnoseHost = async (target: SshTarget, executor: SshExecutor, failure: { readonly id: string; readonly url: string }): Promise<string> => {
    const lines = [`--- readiness diagnostics: ${target.user}@${target.address} (resource "${failure.id}", url ${failure.url}) ---`];
    let session: SshSession;
    try {
        session = await executor.connect(target);
    } catch (error) {
        lines.push(`host ${target.address} unreachable over SSH: ${errorMessage(error)}`);
        return lines.join("\n");
    }
    try {
        const run = async (command: string): Promise<string> => {
            try {
                const result = await session.exec(command);
                const output = `${result.stdout}${result.stderr}`.trim();
                return `$ ${command}\n${output === "" ? "(no output)" : output}${result.code === 0 ? "" : `\n(exit ${result.code})`}`;
            } catch (error) {
                return `$ ${command}\nfailed: ${errorMessage(error)}`;
            }
        };
        lines.push(await run("docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}'"));
        // The failing node's own containers (providers stamp intentic.id), their last log lines usually
        // name the actual fault (bind error, crash loop, misconfiguration).
        const labelled = await session.exec(`docker ps -a --filter label=intentic.id=${failure.id} --format '{{.Names}}'`).catch(() => undefined);
        const names =
            labelled === undefined || labelled.code !== 0
                ? []
                : labelled.stdout
                      .split("\n")
                      .map((line) => line.trim())
                      .filter((line) => line !== "");
        for (const name of names) {
            lines.push(await run(`docker logs --tail 50 ${name}`));
        }
        lines.push(await run("ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null"));
        lines.push(await run("ip -4 -o addr"));
        lines.push(await run(`wget -S -T 5 -O /dev/null ${failure.url} 2>&1`));
    } finally {
        await session.dispose().catch(() => undefined);
    }
    return lines.join("\n");
};
