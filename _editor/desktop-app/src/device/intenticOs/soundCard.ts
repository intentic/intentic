import type { IntenticOsSoundOutputs, IntenticOsSoundStatus } from "@intentic/sandbox-contract/schemas/intentic-os";
import type { IconName, PickerOption } from "@intentic/ui";

// THE SOUND, READ (src-tauri/src/os_settings.rs runs `ic os sound`, settings.ts holds it, SoundCard.vue draws it): the
// glyph beside the slider, the change a slider move makes, the status drawn before ic has answered, and the speakers to
// pick from. Pure, so each case is tested by value (soundCard.test.ts).

/** How long the slider rests before its volume is sent: a drag sends one change, not one per pixel. */
export const SOUND_SETTLE_MS = 250;

/** A change of the sound, as `ic os sound set` takes it. */
export interface SoundChange {
    readonly volume?: number;
    readonly muted?: boolean;
}

export const volumeIconOf = (status: IntenticOsSoundStatus): IconName => (status.muted || status.volume === 0 ? `volume-off` : `volume-up`);

/** A whole volume from 0 to 100, from wherever a slider left it. */
export const volumeOf = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0);

/** Moving the slider while the sound is off turns it back on, as every system's volume does. */
export const volumeChange = (status: IntenticOsSoundStatus, value: number): SoundChange =>
    status.muted ? { volume: volumeOf(value), muted: false } : { volume: volumeOf(value) };

/** Two changes made before the first was sent, as one: the later wins each field it names. */
export const mergeChange = (earlier: SoundChange | undefined, later: SoundChange): SoundChange => ({ ...earlier, ...later });

/** The status once a change lands, drawn at once so the slider does not jump back while ic answers. */
export const soundAfter = (status: IntenticOsSoundStatus, change: SoundChange): IntenticOsSoundStatus => ({
    ...status,
    volume: change.volume === undefined ? status.volume : volumeOf(change.volume),
    muted: change.muted ?? status.muted,
});

/** The speakers, headphones and screens that play sound, by the name the system gives them; the value is ic's id. */
export const outputOptionsOf = (outputs: IntenticOsSoundOutputs): PickerOption[] => outputs.outputs.map((output) => ({ value: String(output.id), label: output.name }));

/** The one sound plays on now, as the picker's value. */
export const currentOutputOf = (outputs: IntenticOsSoundOutputs): string | undefined => {
    const current = outputs.outputs.find((output) => output.default);
    return current === undefined ? undefined : String(current.id);
};
