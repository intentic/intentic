// Small, transparent marks that sit on the app's own rail in either theme.
const mark = (drawing: string): string => `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${drawing}</svg>`,
)}`;

export const homeSandboxLogos = {
    shop: mark(`
        <g stroke="#BD8E67">
            <path d="M10 15h20l1.5 16h-23L10 15Z" fill="#BD8E67" fill-opacity=".12"/>
            <path d="M15 16v-4a5 5 0 0 1 10 0v4"/>
            <path d="m16.5 23 3.5 3.5 3.5-3.5"/>
        </g>
    `),
    research: mark(`
        <circle cx="20" cy="20" r="12" stroke="#7C9B8B" stroke-opacity=".55"/>
        <path d="m24.5 10-1 13.5-8 6.5 1-13.5 8-6.5Z" fill="#7C9B8B" fill-opacity=".16" stroke="#7C9B8B"/>
        <path d="m16.5 16.5 7 7" stroke="#7C9B8B"/>
        <circle cx="20" cy="20" r="1.5" fill="#7C9B8B"/>
    `),
    personal: mark(`
        <g stroke="#A395B3" fill="#A395B3" fill-opacity=".12">
            <path d="M20 20C6 20 7 7 13 9c4 1 7 6 7 11Z"/>
            <path d="M20 20C20 6 33 7 31 13c-1 4-6 7-11 7Z"/>
            <path d="M20 20c14 0 13 13 7 11-4-1-7-6-7-11Z"/>
            <path d="M20 20c0 14-13 13-11 7 1-4 6-7 11-7Z"/>
        </g>
    `),
};
