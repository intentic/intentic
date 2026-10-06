import { DEVICE_FEATURE_SET_SHAPE, type DeviceFacts, type DeviceSandboxOp, deviceSupports, type SandboxShapeWhen } from "@intentic/sandbox-contract";
import { askFrom, type ResourcesForm } from "@intentic/ui/sandbox-resources";
import { t } from "@intentic/ui/i18n";
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

export const tooOldWords = (): string => t(`sandbox.shapeFlow.tooOldToSave`);

/**
 * Why this machine can't save a shape for the next restart, in the truest words there are. An agent as new as the
 * feature can still lack it when the `ic` it drives is older and fetching the current one failed; that agent says so
 * itself (`icOutOfDate`), and telling its owner to update an agent that is already current sends them the wrong way.
 */
export const tooOldToSave = (facts: Pick<DeviceFacts, "icOutOfDate"> | undefined): string => facts?.icOutOfDate ?? tooOldWords();

/**
 * The op and payload for an intent. `running` is the shape the container runs with (the form's own reading of it),
 * used only to spell the old op's delta. Throws, with a sentence for the person, when the agent cannot do it:
 * `refusal` (see `tooOldToSave`) when what it lacks is saving for the next restart.
 */
export const shapeFlow = (
    intent: ShapeIntent,
    canShape: boolean,
    running: ResourcesForm,
    refusal: string = tooOldWords(),
): { readonly op: DeviceSandboxOp; readonly payload: Pick<DeviceSandboxPayload, `shape` | `when` | `resources`> } => {
    if (canShape) {
        return `forget` in intent ? { op: `forget-shape`, payload: {} } : { op: `set-shape`, payload: { shape: contractFields(intent.shape), when: intent.when } };
    }
    if (`forget` in intent || intent.when !== `now`) {
        throw new Error(refusal);
    }
    const resources = askFrom(running, intent.shape);
    if (resources === undefined) {
        throw new Error(t(`sandbox.shapeFlow.nothingDiffers`));
    }
    return { op: `reshape`, payload: { resources } };
};

/** Only a shape applied now recreates the container; a save or a forget touches nothing. */
export const shapeSevers = (intent: ShapeIntent): boolean => !(`forget` in intent) && intent.when === `now`;
