// A local asset catalogue, independent of the application's persona renderer.
const manifest = await fetch("./manifest.json").then((response) => {
    if (!response.ok) throw new Error(`Could not load avatar manifest: ${response.status}`);
    return response.json();
});
const svgNamespace = "http://www.w3.org/2000/svg";
let counter = 0;
let selectedColor = manifest.palette.find((color) => color.id === "sky").hex;
let selectedAccessory = manifest.accessories[0];

function svgElement(name, attributes = {}) {
    const element = document.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
}

function avatar(color, accessory, size) {
    const id = `avatar-tint-${counter++}`;
    const svg = svgElement("svg", { viewBox: `0 0 ${manifest.canvas.join(" ")}`, width: size, height: size, role: "img", "aria-label": `${accessory.label} companion in ${color}` });
    const defs = svgElement("defs");
    const filter = svgElement("filter", { id, "color-interpolation-filters": manifest.colorization.space });
    filter.append(svgElement("feColorMatrix", { type: "saturate", values: 0 }));
    const transfer = svgElement("feComponentTransfer");
    for (const [index, channel] of ["R", "G", "B"].entries()) {
        const value = Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) / 255;
        transfer.append(svgElement(`feFunc${channel}`, { type: "table", tableValues: `0 0.10 ${value * 0.60} ${value} 1` }));
    }
    filter.append(transfer);
    defs.append(filter);
    svg.append(defs);

    function layer(asset, placement = asset.placement) {
        const [x, y, width, height] = placement;
        const viewport = svgElement("svg", { x, y, width, height, viewBox: asset.sourceRect.join(" "), preserveAspectRatio: "xMidYMid meet", overflow: "hidden" });
        const image = svgElement("image", { href: asset.src, width: asset.sourceSize[0], height: asset.sourceSize[1] });
        if (asset.tint) image.setAttribute("filter", `url(#${id})`);
        viewport.append(image);
        svg.append(viewport);
    }

    layer(manifest.layers.body);
    layer(manifest.layers.crown);
    layer(accessory);
    layer(manifest.layers.leftHand, accessory.hands?.left);
    layer(manifest.layers.rightHand, accessory.hands?.right);
    return svg;
}

function update() {
    document.querySelector("#selected-avatar").replaceChildren(avatar(selectedColor, selectedAccessory, "100%"));
    const preset = manifest.palette.find((color) => color.hex.toLowerCase() === selectedColor.toLowerCase());
    document.querySelector("#selection-label").textContent = `${preset?.label ?? selectedColor.toUpperCase()} · ${selectedAccessory.label}`;
    document.querySelector("#color").value = selectedColor;
    document.querySelector("#hex").textContent = selectedColor.toUpperCase();
    document.querySelector("#accessory").value = selectedAccessory.id;
    for (const swatch of document.querySelectorAll(".swatch")) swatch.setAttribute("aria-pressed", String(swatch.dataset.color.toLowerCase() === selectedColor.toLowerCase()));
    document.querySelector("#library").replaceChildren(...manifest.accessories.map((accessory) => {
        const button = document.createElement("button");
        button.className = "card";
        button.type = "button";
        button.setAttribute("aria-pressed", String(accessory.id === selectedAccessory.id));
        const title = document.createElement("strong");
        title.textContent = accessory.label;
        const caption = document.createElement("small");
        caption.textContent = accessory.object;
        button.append(avatar(selectedColor, accessory, 144), title, caption);
        button.addEventListener("click", () => { selectedAccessory = accessory; update(); });
        return button;
    }));
    document.querySelector("#sizes").replaceChildren(...[22, 36, 64, 96].map((size) => {
        const item = document.createElement("div");
        item.className = "size";
        const caption = document.createElement("span");
        caption.textContent = `${size}px`;
        item.append(avatar(selectedColor, selectedAccessory, size), caption);
        return item;
    }));
}

for (const color of manifest.palette) {
    const button = document.createElement("button");
    button.className = "swatch";
    button.type = "button";
    button.dataset.color = color.hex;
    button.style.setProperty("--swatch", color.hex);
    button.setAttribute("aria-label", color.label);
    button.title = color.label;
    button.addEventListener("click", () => { selectedColor = color.hex; update(); });
    document.querySelector("#swatches").append(button);
}
for (const accessory of manifest.accessories) {
    const option = document.createElement("option");
    option.value = accessory.id;
    option.textContent = `${accessory.label} · ${accessory.object}`;
    document.querySelector("#accessory").append(option);
}
document.querySelector("#color").addEventListener("input", (event) => { selectedColor = event.target.value; update(); });
document.querySelector("#accessory").addEventListener("change", (event) => { selectedAccessory = manifest.accessories.find((accessory) => accessory.id === event.target.value); update(); });
document.querySelector("#theme").addEventListener("click", (event) => {
    const light = document.body.classList.toggle("light");
    event.target.textContent = light ? "Dark background" : "Light background";
});
update();
