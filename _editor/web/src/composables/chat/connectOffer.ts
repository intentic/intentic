import { ref } from "vue";

/* WHETHER THE BOARD IS ALREADY MAKING THE OFFER, one claim, so the same card is never argued twice on one
 * screen.
 *
 * The empty board's first screen and the chat's connect gate say the identical thing (ConnectOffer), and on a
 * fresh workspace they are side by side: the board fills the middle column and the chat is docked against it.
 * Two copies of "Try free with Google" a hand's width apart read as two different offers, and the user has to
 * work out that they aren't. So the board takes the argument, it owns the whole empty screen, which is where
 * a first-time reader is actually looking, and the docked gate stands down while it does.
 *
 * A ref rather than a prop or an event because the two components are not related: they are mounted by
 * different routes into different grid areas, with the shell between them. The board raises it while its offer
 * is on screen and drops it on unmount, so nothing has to remember to clear it.
 *
 * This says only that the board is showing it HERE, in this window's own layout. A popped-out chat is a
 * separate window with no board beside it, and mobile shows the two on separate screens, both keep their own
 * gate, and both ask that question themselves (ChatPane) rather than making this flag answer for them. */
export const offerOnBoard = ref(false);
