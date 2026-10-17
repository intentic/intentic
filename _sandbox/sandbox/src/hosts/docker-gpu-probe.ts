import { errorMessage } from "@intentic/base/errors";
import { gpuProbeArgv, gpuProbePassed } from "@intentic/sandbox-run";
import { powershellQuote, shellQuote } from "@intentic/sandbox-run/quote";
import type { CapabilityProbe } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Services } from "../composition.js";
import { succeeded } from "./device-commands.js";
import { callTool, devices } from "./device-reports.js";
import { hostRunningSelf } from "./self-host.js";

// Not being able to ask is not a refusal (CapabilityProbeSchema: `checked: false` is "no test from here"). A host not read
// yet, an agent that refused the command, or a check that never finished leaves the GPU to the launch's own preflight,
// which drops the flag on a host that cannot grant it and says so on the entry; only a device request that ran and failed
// refuses the save.
const unchecked = (message: string): CapabilityProbe => ({ checked: false, ok: false, message });

export const gpuProbeAnswer = (refused: boolean, text: string): CapabilityProbe => {
    if (refused) {
        return unchecked(`The host did not run the GPU check, so it is left to the next start: ${text.trim().slice(0, 500)}`);
    }
    const ok = gpuProbePassed(succeeded(text) ? 0 : 1, text);
    return {
        checked: true,
        ok,
        message: ok
            ? "The host's Docker can use its NVIDIA GPU."
            : `GPU access needs a working NVIDIA GPU, its host driver, and Docker GPU support (nvidia-container-toolkit or CDI). ${text.slice(0, 500)}`,
    };
};

export const probeDockerGpu = async (services: Services): Promise<CapabilityProbe> => {
    if (process.env["SANDBOX_VM"] === "1") {
        return { checked: true, ok: false, message: "GPU access is unsupported on hosted sandboxes." };
    }
    await devices(services);
    const host = await hostRunningSelf(services);
    const image = process.env["SANDBOX_IMAGE"];
    if (host === undefined || !image) {
        return unchecked("The machine running this sandbox is not connected as a device, so its GPU is checked when the sandbox next starts.");
    }
    const facts = services.hostHub.state(host).facts;
    const quote = /powershell|pwsh/i.test(facts?.shell ?? "") ? powershellQuote : shellQuote;
    try {
        const answer = await callTool(
            services,
            host,
            "run_command",
            {
                command: gpuProbeArgv(image).map(quote).join(" "),
                timeoutMs: 20_000,
            },
            AbortSignal.timeout(25_000),
        );
        return gpuProbeAnswer(answer.refused, answer.text);
    } catch (error) {
        return unchecked(`The host GPU check could not finish, so it is left to the next start: ${errorMessage(error)}`);
    }
};
