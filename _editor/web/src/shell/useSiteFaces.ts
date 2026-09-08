// Playfair Display, Baloo 2 and Mukta: used only on the entry screens (/login, /setup), never the app's own Inter.
// Appended lazily on first use, not on every workspace load, and left in place afterward since it's already
// cached. One function, not two, so both screens fetch the identical stylesheet rather than a second file mid-flow.
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
