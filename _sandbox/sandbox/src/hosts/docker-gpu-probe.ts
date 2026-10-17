import { errorMessage } from "@intentic/base/errors";
import { gpuProbeArgv, gpuProbePassed } from "@intentic/sandbox-run";
import { powershellQuote, shellQuote } from "@intentic/sandbox-run/quote";
import type { CapabilityProbe } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Services } from "../composition.js";
import { callTool, devices } from "./device-reports.js";
import { hostRunningSelf } from "./self-host.js";

export const gpuProbeAnswer = (refused: boolean, text: string): CapabilityProbe => {
    const ok = !refused && gpuProbePassed(text.startsWith("Exit code 0 (success).") ? 0 : 1, text);
    return {
        checked: true,
        ok,
        message: ok
            ? "The host's Docker can use its NVIDIA GPU."
            : `GPU access needs a working NVIDIA GPU, its host driver, and Docker GPU support (nvidia-container-toolkit or CDI). ${ 
              text.slice(0, 500)}`,
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
        return { checked: true, ok: false, message: "Connect the device running this sandbox so its host GPU can be checked before saving." };
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
        return {
            checked: true,
            ok: false,
            message: `The host GPU check could not finish: ${errorMessage(error)}`,
        };
    }
};
