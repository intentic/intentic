// Rounded rectangles, one instance each, in pixels from the viewport's top-left: the bubbles, code backgrounds and
// underlines drawn under the transcript's text. The edge is antialiased by its signed distance.

struct Globals {
    size: vec2<f32>,
    _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> globals: Globals;

struct Instance {
    @location(0) rect: vec4<f32>,
    @location(1) color: vec4<f32>,
    @location(2) radius: f32,
};

struct Varyings {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) local: vec2<f32>,
    @location(2) half_size: vec2<f32>,
    @location(3) radius: f32,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32, quad: Instance) -> Varyings {
    let corner = vec2<f32>(f32(vertex & 1u), f32(vertex >> 1u));
    let point = quad.rect.xy + corner * quad.rect.zw;
    var out: Varyings;
    out.position = vec4<f32>(
        point.x / globals.size.x * 2.0 - 1.0,
        1.0 - point.y / globals.size.y * 2.0,
        0.0,
        1.0,
    );
    out.color = quad.color;
    out.half_size = quad.rect.zw * 0.5;
    out.local = (corner - vec2<f32>(0.5, 0.5)) * quad.rect.zw;
    out.radius = quad.radius;
    return out;
}

@fragment
fn fs(in: Varyings) -> @location(0) vec4<f32> {
    let q = abs(in.local) - in.half_size + vec2<f32>(in.radius, in.radius);
    let distance = length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - in.radius;
    let coverage = clamp(0.5 - distance, 0.0, 1.0);
    return vec4<f32>(in.color.rgb, in.color.a * coverage);
}
