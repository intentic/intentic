import { type Fence, fenceHoldsPersona, type Persona } from "@intentic/sandbox-contract";
import { useAreas } from "../areas/useAreas";
import { usePersonas } from "../personas/usePersonas";

// Which assistants a fence hands over — the same derivation the daemon refuses on (personas/persona-reach.ts). An
// assistant lives where it starts, and a person's areas either cover that folder or they do not; nobody picks
// assistants per person any more. Read by the picker that chooses the fence and by the rows that report it, so what
// the screen promises is what the daemon will accept.

export function usePersonaReach() {
    const { personas } = usePersonas();
    const { areas } = useAreas();

    // Undefined stays undefined: no area named is the whole workspace, not a fence that happens to hold no folder.
    const fenceOf = (held: readonly string[] | undefined): Fence =>
        held === undefined ? undefined : [...new Set(held.flatMap((id) => areas.value.find((area) => area.id === id)?.folders ?? []))];

    const reach = (held: readonly string[] | undefined): Persona[] => personas.value.filter((card) => fenceHoldsPersona(fenceOf(held), card));

    return {
        reach,
        // How the assistants are named wherever this is reported, in the order the roster holds them.
        namesOf: (held: readonly string[] | undefined): string[] => reach(held).map((card) => card.label ?? card.id),
    };
}
