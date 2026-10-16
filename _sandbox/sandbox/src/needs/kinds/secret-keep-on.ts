import { DEVICE_FEATURE_KEYRING, deviceSupports } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { SecretKeepOn } from "../need-kinds.js";
import { NeedRefusal } from "../needs.js";

// "Keep it on my computer": the value goes to that computer's keyring inbox, sealed to its key, and nothing is stored
// here; this sandbox holds a pointer to it once the keyring takes it in. A computer without a keyring, or not connected,
// is refused before anything is sent, saying which.
export const keepOnDevice = async (services: Pick<Services, "hostHub" | "keyringLink">, name: string, value: string, keepOn: SecretKeepOn): Promise<{ readonly pending: boolean }> => {
    const { device } = keepOn;
    if (!deviceSupports(services.hostHub.state(device).facts, DEVICE_FEATURE_KEYRING)) {
        throw new NeedRefusal(
            "invalid",
            services.hostHub.online(device)
                ? `${device} has no keyring: its agent does not offer one, so it cannot keep ${name}. Install the keyring there (intentic-machine keyring), or keep the value in the sandbox.`
                : `${device} is not connected right now, so its keyring cannot take ${name}: keep the value in the sandbox, or try again once that computer is on.`,
        );
    }
    const answer = await services.keyringLink.inbox({ machine: device, name, value, mode: keepOn.mode, kind: "password", programs: [], hosts: [] });
    if (!answer.ok) {
        throw new NeedRefusal("invalid", `${name} could not be kept on ${device}: ${answer.refusal}`);
    }
    return { pending: answer.pending };
};

