/* THE ORNAMENT KIT for the Angkor landing (`/angkor/`), an alternative treatment of the home page.
 *
 * Every flourish on that page is one of these five shapes, drawn in `currentColor` so a caller sets the
 * metal by setting a text colour. They are strings rather than components because most of them are used
 * inside CSS `background-image` as well as in markup, and one definition that can do both is the only way
 * the drawn corner and the CSS corner cannot drift apart.
 *
 * The vocabulary is the reference image's: a lotus (the brand's own mark, and the bullet of every list on
 * the page), a double-ruled corner with a lozenge at its elbow (every frame and every button), a lozenge on
 * its own (dividers, list bullets, the seam between chips) and a radiant mandala (the glows in the sky of
 * the hero).
 */

/** The lotus, five petals over two leaves. The brand mark of the page: the wordmark's companion, every
 *  chip's bullet, and the finial centred on the top rail of each window frame.
 *
 *  FILLED, not stroked, and that is the whole design constraint. Its commonest job is a 15px list bullet,
 *  and at 15px a 1px stroke on a 32-unit grid lands at half a device pixel: the outlined version of this
 *  drawing resolved into a grey asterisk in every chip on the page. Solid petals hold their silhouette at
 *  any size, and the petals are separated by falling opacity rather than by gaps — an outline needs room
 *  between shapes to read, a tonal step does not. */
export const LOTUS = `<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
  <path d="M8.4 25.6c-3.2 0-5.6-1-7.2-3 3.6-1.2 6.6-.7 9 1.4z" opacity=".42"/>
  <path d="M23.6 25.6c3.2 0 5.6-1 7.2-3-3.6-1.2-6.6-.7-9 1.4z" opacity=".42"/>
  <path d="M16 9.5c2.1 3 3.2 5.7 3.2 8.1 0 2.2-1.1 4.1-3.2 5.6-2.1-1.5-3.2-3.4-3.2-5.6 0-2.4 1.1-5.1 3.2-8.1z" transform="rotate(-74 16 22.6)" opacity=".55"/>
  <path d="M16 9.5c2.1 3 3.2 5.7 3.2 8.1 0 2.2-1.1 4.1-3.2 5.6-2.1-1.5-3.2-3.4-3.2-5.6 0-2.4 1.1-5.1 3.2-8.1z" transform="rotate(74 16 22.6)" opacity=".55"/>
  <path d="M16 6.4c2.4 3.4 3.6 6.4 3.6 9.1 0 2.5-1.2 4.6-3.6 6.3-2.4-1.7-3.6-3.8-3.6-6.3 0-2.7 1.2-5.7 3.6-9.1z" transform="rotate(-39 16 21.7)" opacity=".78"/>
  <path d="M16 6.4c2.4 3.4 3.6 6.4 3.6 9.1 0 2.5-1.2 4.6-3.6 6.3-2.4-1.7-3.6-3.8-3.6-6.3 0-2.7 1.2-5.7 3.6-9.1z" transform="rotate(39 16 21.7)" opacity=".78"/>
  <path d="M16 3.4c2.8 4 4.2 7.5 4.2 10.6 0 2.9-1.4 5.4-4.2 7.3-2.8-1.9-4.2-4.4-4.2-7.3 0-3.1 1.4-6.6 4.2-10.6z"/>
</svg>`;

/** The lozenge: the page's full stop. A bullet in a list, the knot in a divider, the stud at a frame's elbow. */
export const LOZENGE = `<svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
  <path d="M6 .8 11.2 6 6 11.2.8 6z" stroke="currentColor" stroke-width="1.1"/>
  <path d="M6 3.6 8.4 6 6 8.4 3.6 6z" fill="currentColor" opacity=".55"/>
</svg>`;

/** The top-left corner of a frame: two rules turning together, with a lozenge on the elbow and a small
 *  curl running back along each arm. Rotated in CSS for the other three. */
export const CORNER = `<svg viewBox="0 0 44 44" fill="none" aria-hidden="true">
  <g stroke="currentColor" stroke-width="1.1" stroke-linecap="round">
    <path d="M43 1H13.5A12.5 12.5 0 0 0 1 13.5V43"/>
    <path d="M43 7H16a9 9 0 0 0-9 9v27" opacity=".55"/>
    <path d="M25 1c0 3.9-3.1 7-7 7"/>
    <path d="M1 25c3.9 0 7-3.1 7-7"/>
  </g>
  <path d="M12.5 8.6 16.4 12.5 12.5 16.4 8.6 12.5z" stroke="currentColor" stroke-width="1" fill="none"/>
</svg>`;

/** The sky ornaments: a ringed star, the same figure the reference image scatters above the temple.
 *  Used at low opacity behind the hero and the closing band. */
export const MANDALA = `<svg viewBox="0 0 120 120" fill="none" aria-hidden="true">
  <g stroke="currentColor" stroke-width="1">
    <circle cx="60" cy="60" r="14" opacity=".9"/>
    <circle cx="60" cy="60" r="26" opacity=".6"/>
    <circle cx="60" cy="60" r="40" opacity=".35"/>
    <circle cx="60" cy="60" r="54" opacity=".18"/>
    <path d="M60 0v120M0 60h120M18 18l84 84M102 18l-84 84" opacity=".22"/>
  </g>
  <circle cx="60" cy="60" r="5" fill="currentColor"/>
</svg>`;

/** The rule between a block of copy and what it leads to: a hairline out of nothing on both sides, a
 *  lozenge in the middle. Rendered as markup rather than a border because both halves fade. */
export const DIVIDER = `<svg viewBox="0 0 240 16" fill="none" aria-hidden="true" preserveAspectRatio="none">
  <defs>
    <linearGradient id="a-div-l" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity="0"/><stop offset="1" stop-color="currentColor" stop-opacity=".8"/></linearGradient>
    <linearGradient id="a-div-r" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".8"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient>
  </defs>
  <path d="M0 8h104" stroke="url(#a-div-l)" stroke-width="1"/>
  <path d="M136 8h104" stroke="url(#a-div-r)" stroke-width="1"/>
  <path d="M120 2l6 6-6 6-6-6z" stroke="currentColor" stroke-width="1"/>
  <path d="M120 5l3 3-3 3-3-3z" fill="currentColor" opacity=".6"/>
  <path d="M108 8h4M128 8h4" stroke="currentColor" stroke-width="1" opacity=".7"/>
</svg>`;
