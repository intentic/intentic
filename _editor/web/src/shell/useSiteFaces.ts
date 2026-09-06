/* THE SITE'S THREE FACES, FETCHED BY THE ENTRY SCREENS AND BY NO OTHER ROUTE.
 *
 * Playfair Display sets the one heading drawn at display size, Baloo 2 sets the mark and every card title, and
 * Mukta sets the reading copy — which together are what make the type on `/login` and `/setup` the type on the
 * page a visitor arrived from. The app's own Inter is none of the three.
 *
 * Charging every workspace load for faces used on two screens is the thing to avoid, so the <link> is appended
 * when one of those screens is set up, the way `skins/useSkin.ts` fetches its own. It is left behind
 * afterwards: the files are in cache by then, and removing it only risks a second download if the visitor comes
 * back. `display=swap` means a slow font costs a reflow, never a blank page.
 *
 * It is a function rather than two copies of five lines because the two screens have to ask for the SAME
 * stylesheet: they are read back to back, and a second element with a different family list would fetch a
 * second file mid-flow and re-lay one of the two screens out under the reader. */
const FACE_ELEMENT_ID = `entry-site-faces`;
const FACE_HREF = `https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600&family=Mukta:wght@400;500;600&family=Playfair+Display:wght@600&display=swap`;

export const useSiteFaces = (): void => {
    if (document.getElementById(FACE_ELEMENT_ID) !== null) {
        return;
    }
    const link = document.createElement(`link`);
    link.id = FACE_ELEMENT_ID;
    link.rel = `stylesheet`;
    link.href = FACE_HREF;
    document.head.append(link);
};
