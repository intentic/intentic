import { DEVICE_FEATURE_SET_SHAPE, type DeviceFacts, type DeviceSandboxOp, deviceSupports, type SandboxShapeWhen } from "@intentic/sandbox-contract";
import { askFrom, type ResourcesForm } from "@intentic/ui/sandbox-resources";
import type { DeviceSandboxPayload } from "./useDevices";

// WHAT THE RESOURCES FORM'S ANSWER BECOMES ON THE WIRE. The form holds a whole shape; the machine's `ic` stores and
// applies whole shapes (`set-shape`, `forget-shape`), so nothing here merges anything. The one exception is an agent
// older than `set-shape`, which only knows the old `reshape` op: it is sent the fields that differ from what runs, now,
// and nothing can be saved for its next restart.

/** A shape and when it takes effect, or dropping the one saved for the next restart. */
export type ShapeIntent = { readonly shape: ResourcesForm; readonly when: SandboxShapeWhen } | { readonly forget: true };

// The contract's four fields and nothing else: the agent refuses a field it does not know, and a form opened on a newer
// machine's report may carry one.
const contractFields = ({ memoryGib, cpus, privileged, gpu }: ResourcesForm): ResourcesForm => ({ memoryGib, cpus, privileged, gpu });

/** Whether this machine's agent takes whole shapes (and so can save one for the next restart). */
export const canSetShape = (facts: Pick<DeviceFacts, "features"> | undefined): boolean => deviceSupports(facts, DEVICE_FEATURE_SET_SHAPE);

export const TOO_OLD_TO_SAVE = `This machine's agent is too old to save a change for the next restart. Update its agent first.`;

/**
 * The op and payload for an intent. `running` is the shape the container runs with (the form's own reading of it),
 * used only to spell the old op's delta. Throws, with a sentence for the person, when the agent cannot do it.
 */
export const shapeFlow = (
    intent: ShapeIntent,
    canShape: boolean,
    running: ResourcesForm,
): { readonly op: DeviceSandboxOp; readonly payload: Pick<DeviceSandboxPayload, `shape` | `when` | `resources`> } => {
    if (canShape) {
        return `forget` in intent ? { op: `forget-shape`, payload: {} } : { op: `set-shape`, payload: { shape: contractFields(intent.shape), when: intent.when } };
    }
    if (`forget` in intent || intent.when !== `now`) {
        throw new Error(TOO_OLD_TO_SAVE);
    }
    const resources = askFrom(running, intent.shape);
    if (resources === undefined) {
        throw new Error(`Nothing differs from what this sandbox runs, so there is nothing to apply.`);
    }
    return { op: `reshape`, payload: { resources } };
};

/** Only a shape applied now recreates the container; a save or a forget touches nothing. */
export const shapeSevers = (intent: ShapeIntent): boolean => !(`forget` in intent) && intent.when === `now`;
