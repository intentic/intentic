import type { ReadinessProbe, ResolvedInputs } from "@intentic/engine";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { SshExecutor, SshSession, SshTarget } from "./ssh.js";
import { sshExecutor } from "./ssh.js";

// The host's resolved inputs are exactly the shared SSH-creds block; map them to the transport target so a
// caller (the CLI) can build a probe from the graph's host node.
export const hostTarget = (inputs: ResolvedInputs): SshTarget => sshTarget(parseInputs(sshSchema, inputs, "host"));

// Probe readiness FROM THE HOST over SSH. Every readyWhen url in the graph is host-internal
// (http://<internalIp>:<port>) — reachable from the host itself, never from the CLI process (a laptop/CI
// box deploying to a remote box cannot route to its private ip). Run busybox `wget` over SSH, exactly like
// the platform providers' own health checks (komodo.ts/forgejo.ts). expectedStatus is ignored: every gate
// is httpOk (expect 200) and `wget -q` already exits non-zero on 4xx/5xx, matching httpProbe's semantics.
// A session is opened and disposed per call (waitReady polls); any SSH/connect error means "not ready yet",
// so return false and let waitReady keep polling until its deadline rather than aborting the apply.
export const createSshProbe =
    (target: SshTarget, executor: SshExecutor = sshExecutor): ReadinessProbe =>
    async (url) => {
        let session: SshSession;
        try {
            session = await executor.connect(target);
        } catch {
            return false;
        }
        try {
            return (await session.exec(`wget -q -T 10 -O /dev/null ${url}`)).code === 0;
        } catch {
            return false;
        } finally {
            await session.dispose();
        }
    };
