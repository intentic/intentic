import type { DisposableStore } from "@intentic/base/lifecycle";
import type { Logger } from "pino";
import type { Services } from "../composition.js";
import type { Config } from "../env.config.js";
import type { ContainerRole } from "../system/boot/container-owner.js";
import type { ProfileTraits } from "../system/boot/profile.js";

// What every phase of boot is handed, so a phase reads its inputs instead of re-deriving them: the config this daemon
// was started with, the services built from it, the profile's named traits, the role it claimed over the container,
// and the one store every teardown registers with. Nothing here enumerates what to stop.
export interface BootPhase {
    readonly config: Config;
    readonly logger: Logger;
    readonly traits: ProfileTraits;
    readonly role: ContainerRole;
    readonly services: Services;
    readonly shutdown: DisposableStore;
}
