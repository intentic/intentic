// The pointer the recording can see. A headless browser draws no cursor and Playwright's mouse leaves no trace,
// so a video of it looks like the UI operating itself — clicks land with nothing to explain them. This runs as an
// init script (before the app), listens to the same trusted mouse events the app receives, and draws a cursor plus
// a click ripple over everything. Nothing here is reachable from app code: it is one fixed-position layer with
// pointer-events off, and it never touches the page's own DOM.
//
// It also carries the drag ghost, because a dropped folder has the same problem: `Input.dispatchDragEvent` moves
// files into the page with no visible carrier, and "a repo arrives from off-screen" is the whole first beat.
//
// An init script runs before the document has a root element, so the layer is built on DOMContentLoaded while the
// listeners (and the position they track) are live from the first frame — the pointer is already where it belongs
// when the layer appears, rather than starting at the origin and flying in.
(() => {
    let cursor;
    let ripple;
    let ghost;
    let x = -9999;
    let y = -9999;

    const place = () => {
        if (cursor === undefined) {
            return;
        }
        cursor.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
        ghost.style.transform = `translate(${x + 16}px, ${y + 14}px)`;
    };

    // Both event names: a CDP drag is dispatched as dragOver, which fires no mousemove.
    for (const name of ["mousemove", "dragover"]) {
        window.addEventListener(
            name,
            (event) => {
                x = event.clientX;
                y = event.clientY;
                place();
            },
            true,
        );
    }
    window.addEventListener(
        "mousedown",
        () => {
            if (ripple === undefined) {
                return;
            }
            ripple.style.transform = `translate(${x}px, ${y}px)`;
            ripple.classList.remove("fire");
            void ripple.offsetWidth; // restart the animation
            ripple.classList.add("fire");
        },
        true,
    );

    window.promoDragGhost = (label, count) => {
        if (ghost === undefined) {
            return;
        }
        if (label === undefined) {
            ghost.classList.remove("on");
            return;
        }
        ghost.querySelector(".name").textContent = label;
        ghost.querySelector(".count").textContent = count === undefined ? "" : count;
        ghost.classList.add("on");
        place();
    };

    const install = () => {
        const style = document.createElement("style");
        style.textContent = `
        #promo-cursor-layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
        #promo-cursor { position: absolute; left: 0; top: 0; width: 22px; height: 22px; will-change: transform;
            transform: translate(-9999px, -9999px); filter: drop-shadow(0 2px 6px rgba(0,0,0,.55)); }
        #promo-ripple { position: absolute; left: 0; top: 0; width: 14px; height: 14px; margin: -7px 0 0 -7px;
            border-radius: 999px; border: 2px solid rgba(255,255,255,.9); opacity: 0; transform: translate(-9999px, -9999px); }
        #promo-ripple.fire { animation: promo-ripple-out 520ms cubic-bezier(.2,.7,.3,1); }
        @keyframes promo-ripple-out {
            0%   { opacity: .95; width: 14px; height: 14px; margin: -7px 0 0 -7px; }
            100% { opacity: 0;   width: 54px; height: 54px; margin: -27px 0 0 -27px; }
        }
        #promo-ghost { position: absolute; left: 0; top: 0; display: none; align-items: center; gap: 8px;
            padding: 8px 12px 8px 10px; border-radius: 10px; transform: translate(-9999px, -9999px);
            background: rgba(28,26,24,.94); border: 1px solid rgba(255,255,255,.14);
            box-shadow: 0 18px 40px rgba(0,0,0,.55); color: #f2efea; font: 500 13px/1.2 ui-sans-serif, system-ui, sans-serif;
            white-space: nowrap; }
        #promo-ghost.on { display: flex; }
        #promo-ghost .count { color: #a8a29b; font-weight: 400; }
    `;
        document.documentElement.appendChild(style);

        const layer = document.createElement("div");
        layer.id = "promo-cursor-layer";
        layer.innerHTML = `
        <svg id="promo-cursor" viewBox="0 0 24 24" fill="none">
            <path d="M5 2.5 L5 19.2 L9.2 15.2 L11.9 21.2 L14.8 19.9 L12.1 14 L18 14 Z"
                  fill="#ffffff" stroke="rgba(0,0,0,.45)" stroke-width="1.1" stroke-linejoin="round"/>
        </svg>
        <div id="promo-ripple"></div>
        <div id="promo-ghost">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#e8a44a"><path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h4l2 2.2h7A1.5 1.5 0 0 1 19 7.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5Z"/></svg>
            <span class="name"></span><span class="count"></span>
        </div>`;
        document.documentElement.appendChild(layer);

        cursor = layer.querySelector("#promo-cursor");
        ripple = layer.querySelector("#promo-ripple");
        ghost = layer.querySelector("#promo-ghost");
        place();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", install, { once: true });
    } else {
        install();
    }
})();
