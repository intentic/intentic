//! The GPU half: a wgpu device (Vulkan where the phone has a usable one, GL ES otherwise), the swapchain on the
//! `SurfaceView`'s window, a pipeline for the rectangles under the text, and glyphon for the text itself.

use super::text::Quad;
use glyphon::cosmic_text::FontSystem;
use glyphon::{
    Cache, ColorMode, Resolution, SwashCache, TextArea, TextAtlas, TextRenderer, Viewport,
};
use wgpu::{
    Backends, BlendState, BufferUsages, ColorTargetState, ColorWrites, CompositeAlphaMode,
    CurrentSurfaceTexture, PresentMode, SurfaceConfiguration, TextureUsages,
};

/// An adapter and its device, which can be made before there is a window to draw on.
pub(crate) struct Device {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
}

impl Device {
    pub fn new(backends: Backends) -> Result<Device, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            ..Default::default()
        }))
        .map_err(|error| format!("{backends:?}: {error}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("spike.surface"),
            required_limits:
                wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
            ..Default::default()
        }))
        .map_err(|error| format!("{backends:?}: {error}"))?;
        // wgpu panics on an error nobody captured; a spike logs it and keeps drawing.
        device.on_uncaptured_error(std::sync::Arc::new(|error| log::error!("wgpu: {error}")));
        Ok(Device {
            instance,
            adapter,
            device,
            queue,
        })
    }

    pub fn describe(&self) -> String {
        let info = self.adapter.get_info();
        format!(
            "{:?} {} ({} {})",
            info.backend, info.name, info.driver, info.driver_info
        )
    }
}

/// The rectangle pipeline: one instance per [`Quad`], as `[x, y, w, h, r, g, b, a, radius]`.
struct Quads {
    pipeline: wgpu::RenderPipeline,
    globals: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    instances: wgpu::Buffer,
    capacity: usize,
    count: u32,
}

const QUAD_FLOATS: usize = 9;

impl Quads {
    fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("spike.quads"),
            source: wgpu::ShaderSource::Wgsl(include_str!("quad.wgsl").into()),
        });
        let globals = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("spike.quads.globals"),
            size: 16,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("spike.quads"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("spike.quads"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: globals.as_entire_binding(),
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("spike.quads"),
            bind_group_layouts: &[Some(&layout)],
            ..Default::default()
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("spike.quads"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: (QUAD_FLOATS * 4) as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32],
                })],
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(ColorTargetState {
                    format,
                    blend: Some(BlendState::ALPHA_BLENDING),
                    write_mask: ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let capacity = 256;
        Quads {
            pipeline,
            globals,
            bind_group,
            instances: Self::instances(device, capacity),
            capacity,
            count: 0,
        }
    }

    fn instances(device: &wgpu::Device, capacity: usize) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("spike.quads.instances"),
            size: (capacity * QUAD_FLOATS * 4) as u64,
            usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    fn upload(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        size: (u32, u32),
        quads: &[Quad],
        linear: bool,
    ) {
        let globals = [size.0 as f32, size.1 as f32, 0.0, 0.0];
        queue.write_buffer(&self.globals, 0, &bytes(&globals));
        if quads.len() > self.capacity {
            self.capacity = quads.len().next_power_of_two();
            self.instances = Self::instances(device, self.capacity);
        }
        let mut floats = Vec::with_capacity(quads.len() * QUAD_FLOATS);
        for quad in quads {
            let [r, g, b, a] = rgba(quad.color, linear);
            floats.extend_from_slice(&[quad.x, quad.y, quad.w, quad.h, r, g, b, a, quad.radius]);
        }
        if !floats.is_empty() {
            queue.write_buffer(&self.instances, 0, &bytes(&floats));
        }
        self.count = quads.len() as u32;
    }

    fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        if self.count == 0 {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.set_vertex_buffer(0, self.instances.slice(..));
        pass.draw(0..4, 0..self.count);
    }
}

fn bytes(floats: &[f32]) -> Vec<u8> {
    floats
        .iter()
        .flat_map(|value| value.to_ne_bytes())
        .collect()
}

/// An ARGB colour as the shader wants it: as is for a plain swapchain, decoded to linear light for an sRGB one.
fn rgba(argb: u32, linear: bool) -> [f32; 4] {
    let channel = |shift: u32| ((argb >> shift) & 0xFF) as f32 / 255.0;
    let decode = |value: f32| {
        if !linear {
            value
        } else if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    };
    [
        decode(channel(16)),
        decode(channel(8)),
        decode(channel(0)),
        channel(24),
    ]
}

pub(crate) struct Gpu {
    device: Device,
    surface: wgpu::Surface<'static>,
    config: SurfaceConfiguration,
    /// The swapchain is sRGB, so colours are written in linear light.
    linear: bool,
    quads: Quads,
    atlas: TextAtlas,
    text: TextRenderer,
    viewport: Viewport,
    describe: String,
}

impl Gpu {
    /// Draws on `window` with Vulkan (`vulkan`, made ahead by `prepare`, or now) unless there is no Vulkan device or
    /// it cannot present to the window, then with GL ES. A GL device is made here, on the thread that draws: made on
    /// another, its EGL context is not usable on this one.
    pub fn connect<W: wgpu::WindowHandle + wgpu::rwh::HasDisplayHandle + 'static>(
        vulkan: Option<Result<Device, String>>,
        window: impl Fn() -> W,
        width: u32,
        height: u32,
    ) -> Result<Gpu, String> {
        let refused = match vulkan
            .unwrap_or_else(|| Device::new(Backends::VULKAN))
            .and_then(|device| Gpu::on(device, window(), width, height))
        {
            Ok(gpu) => return Ok(gpu),
            Err(refused) => refused,
        };
        log::warn!("no Vulkan, using GL ES: {refused}");
        Device::new(Backends::GL)
            .and_then(|device| Gpu::on(device, window(), width, height))
            .map_err(|error| format!("{refused}; {error}"))
    }

    fn on<W: wgpu::WindowHandle + wgpu::rwh::HasDisplayHandle + 'static>(
        device: Device,
        window: W,
        width: u32,
        height: u32,
    ) -> Result<Gpu, String> {
        let describe = device.describe();
        let surface = device
            .instance
            .create_surface(window)
            .map_err(|error| format!("{describe}: {error}"))?;
        if !device.adapter.is_surface_supported(&surface) {
            return Err(format!("{describe}: cannot present to the window"));
        }
        let caps = surface.get_capabilities(&device.adapter);
        // A plain (not sRGB) swapchain blends as Android's own text does, in the colours' own space.
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|format| !format.is_srgb())
            .or_else(|| caps.formats.first().copied())
            .ok_or_else(|| format!("{describe}: the window offers no format"))?;
        let alpha_mode = if caps.alpha_modes.contains(&CompositeAlphaMode::Opaque) {
            CompositeAlphaMode::Opaque
        } else {
            caps.alpha_modes
                .first()
                .copied()
                .unwrap_or(CompositeAlphaMode::Auto)
        };
        let config = SurfaceConfiguration {
            usage: TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: Default::default(),
            width: width.max(1),
            height: height.max(1),
            present_mode: PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode,
            view_formats: Vec::new(),
        };
        surface.configure(&device.device, &config);
        let linear = format.is_srgb();
        let cache = Cache::new(&device.device);
        let color_mode = if linear {
            ColorMode::Accurate
        } else {
            ColorMode::Web
        };
        let mut atlas =
            TextAtlas::with_color_mode(&device.device, &device.queue, &cache, format, color_mode);
        let text = TextRenderer::new(&mut atlas, &device.device, Default::default(), None);
        let viewport = Viewport::new(&device.device, &cache);
        let quads = Quads::new(&device.device, format);
        log::info!("surface: {describe}, {format:?}, {alpha_mode:?}");
        Ok(Gpu {
            describe: format!("{describe} {format:?}"),
            device,
            surface,
            config,
            linear,
            quads,
            atlas,
            text,
            viewport,
        })
    }

    pub fn describe(&self) -> &str {
        &self.describe
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.surface.configure(&self.device.device, &self.config);
    }

    /// Draws one frame: the quads, then the text over them. False when the swapchain gave no image (it was
    /// reconfigured or is not shown), and another frame should try again.
    pub fn draw<'a>(
        &mut self,
        fonts: &mut FontSystem,
        swash: &mut SwashCache,
        areas: impl IntoIterator<Item = TextArea<'a>>,
        quads: &[Quad],
    ) -> bool {
        let frame = match self.surface.get_current_texture() {
            CurrentSurfaceTexture::Success(frame) | CurrentSurfaceTexture::Suboptimal(frame) => {
                frame
            }
            CurrentSurfaceTexture::Outdated | CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device.device, &self.config);
                return false;
            }
            other => {
                log::warn!("no swapchain image: {other:?}");
                return false;
            }
        };
        let (device, queue) = (&self.device.device, &self.device.queue);
        let size = (self.config.width, self.config.height);
        self.viewport.update(
            queue,
            Resolution {
                width: size.0,
                height: size.1,
            },
        );
        if let Err(error) = self.text.prepare(
            device,
            queue,
            fonts,
            &mut self.atlas,
            &self.viewport,
            areas,
            swash,
        ) {
            log::error!("glyphon prepare: {error}");
        }
        self.quads.upload(device, queue, size, quads, self.linear);

        let view = frame.texture.create_view(&Default::default());
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let [r, g, b, _] = rgba(super::style::CANVAS, self.linear);
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("spike.transcript"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: r.into(),
                            g: g.into(),
                            b: b.into(),
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            self.quads.draw(&mut pass);
            if let Err(error) = self.text.render(&self.atlas, &self.viewport, &mut pass) {
                log::error!("glyphon render: {error}");
            }
        }
        queue.submit([encoder.finish()]);
        queue.present(frame);
        self.atlas.trim();
        true
    }
}
