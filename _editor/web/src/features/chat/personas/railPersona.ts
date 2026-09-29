import { ref } from "vue";

// The persona the rail's Personas cut has picked, for the rail's foot: its New agent press starts a chat as whoever is
// picked there, as the tile's own "+" does, so the cut about speaking as someone never quietly starts a chat as nobody.
// Undefined while Anyone is picked or the cut isn't on screen; the rail clears it when it goes (ChatPersonaRail).
export const railPersona = ref<{ readonly id: string; readonly label: string } | undefined>();
