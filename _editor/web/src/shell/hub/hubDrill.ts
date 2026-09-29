// How a hub's index and its sections share a phone's screen, as plain decisions <HubLayout> reads, so they can be held
// to without mounting a hub under a faked viewport.

/**
 * Whether a hub drills down: its root an index, each section a page of its own with a way back to it. Only on a
 * phone, and not for a reader who may not stand on the root (a guest's hub, `addressable`) or a hub of one section,
 * neither of which has an index worth a page.
 */
export const hubDrills = (phone: boolean, addressable: boolean, sections: number): boolean => phone && !addressable && sections > 1;

/**
 * The `:tab` param a section's row links to. The default section's is the param-less URL wherever that URL shows it;
 * where it does not (drilled, the param-less URL is the index; a guest's root is fenced off), every row names itself.
 */
export const hubSectionParam = (slug: string, defaultSlug: string, named: boolean): string | undefined =>
    slug === defaultSlug && !named ? undefined : slug;
