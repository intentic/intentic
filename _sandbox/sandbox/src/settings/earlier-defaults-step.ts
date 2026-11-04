import { dirname, join } from "node:path";
import { parseJsonWith } from "@intentic/base/json";
import { isNewer } from "@intentic/sandbox-contract/state/versions";
import type { PrivacyShieldPolicy } from "@intentic/sandbox-contract/schemas/privacy";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { z } from "zod";
import { privacyShieldDocument } from "../privacy/privacy-policy.js";
import { newestRunDocument } from "../store/newest-run.js";
import { defineStep } from "../store/evolution/state-steps.js";
import { settingsDocument } from "./settings-store.js";

// New sandboxes start with the privacy shield masking, the iq search teaching and the project map (2026-11-04); a sandbox
// that ran before that keeps what it had. A file that names a key keeps its value, and one that does not reads the old
// default (settings-store.ts pins it; a policy without `mode` reads off anyway). What neither covers is a file never
// written, which reads as the new answer: so a sandbox whose newest-run stamp names a release from before the change,
// and never wrote one of these files, gets the old values written down once, here. A sandbox stamped with no release
// (a first boot, or only ever run by a dev build) is read as new.
//
// The release the change shipped after. The decision cannot wait for the stamp to move, since the first boot of a newer
// release moves it; it is written down on that boot instead, after which the file exists and the step settles.
const EARLIER_DEFAULTS_BEFORE = "1.394.0";

const StampSchema = z.object({ version: z.string().optional().catch(undefined) });

const stampVersion = (text: string | undefined): string | undefined => (text === undefined ? undefined : parseJsonWith(text, StampSchema)?.version);

const ranBefore = (version: string | undefined): boolean => version !== undefined && version !== "0.0.0" && !isNewer(version, EARLIER_DEFAULTS_BEFORE);

const spelled = (value: Partial<SandboxSettings> | Partial<PrivacyShieldPolicy>): string => `${JSON.stringify(value, undefined, 2)}\n`;

export const earlierDefaultsStep = defineStep({
    id: "earlier-defaults-2026-11",
    describe: "writes down the privacy shield, iq search and project map defaults a sandbox from before 2026-11 ran on, where it never saved them",
    plan: async ({ roots, read, kind }) => {
        if (!ranBefore(stampVersion(await read(join(roots.workspace, newestRunDocument.path))))) {
            return undefined;
        }
        const owed = [
            { path: join(roots.workspace, settingsDocument.path), text: spelled({ iqSearch: false, workspaceMap: false }), change: "keeps iq search and the project map off" },
            { path: join(roots[privacyShieldDocument.root], privacyShieldDocument.path), text: spelled({ mode: "off" }), change: "keeps the privacy shield off" },
        ];
        const writes = new Map<string, string>();
        const changes: string[] = [];
        for (const file of owed) {
            // Only into a folder that is there: a step writes no directories, and a sandbox without the folder never ran
            // far enough to hold a setting.
            if ((await read(file.path)) === undefined && (await kind(dirname(file.path))) === "directory") {
                writes.set(file.path, file.text);
                changes.push(file.change);
            }
        }
        return writes.size === 0 ? undefined : { changes, writes };
    },
});
