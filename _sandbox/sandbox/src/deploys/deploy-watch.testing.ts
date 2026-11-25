import { unstubbed } from "@intentic/testing";
import type { CiPass } from "./deploy-triggers.js";
import type { DeployWatch } from "./deploy-watch.js";

// THE DEPLOYS WATCH AS CI REACHES IT (ci/webhook.routes.ts, ci/events.ts): every pass kept, nothing deployed. Types
// only besides the fake, so a CI suite that mocks modules by path loads nothing of the watch's own. Not part of the
// build.

export const heardPasses = () => {
    const passes: CiPass[] = [];
    const deployWatch = unstubbed<DeployWatch>("deployWatch", {
        ciPassed: async (pass: CiPass) => {
            passes.push(pass);
            return [];
        },
    });
    return { passes, deployWatch };
};
