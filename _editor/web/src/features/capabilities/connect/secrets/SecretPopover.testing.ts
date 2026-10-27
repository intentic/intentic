import { defineComponent, h } from "vue";

// The panel a secret's setting is changed in, drawn in place while open: what it offers and what its Save sends are what
// a fact's suite pins; anchoring it to the value and swapping it for a sheet on a phone are the overlay's own business,
// tested where it lives. Its Save and Cancel are plain buttons named as the real ones are.
export const SecretPopoverStub = defineComponent({
    name: `SecretPopover`,
    props: {
        modelValue: { type: Boolean, required: true },
        header: { type: String, required: true },
        canSave: { type: Boolean, default: true },
        bare: { type: Boolean, default: false },
        saving: { type: Boolean, default: false },
        error: { type: Object, default: undefined },
    },
    emits: [`update:modelValue`, `save`],
    setup: (props, { slots, emit }) => () =>
        props.modelValue
            ? h(`div`, { "data-popover": props.header }, [
                  slots[`default`]?.(),
                  props.bare
                      ? null
                      : h(`button`, { type: `button`, onClick: () => emit(`update:modelValue`, false) }, `Cancel`),
                  props.bare ? null : h(`button`, { type: `button`, disabled: !props.canSave, onClick: () => emit(`save`) }, `Save`),
              ])
            : null,
});
