//! LiquidRust showcase: the whole `liquid-rust` API exposed to the browser.
//!
//! The page draws its content (background, title, slider fills) into a 2D canvas every
//! time it changes; [`Showcase::set_content`] uploads it and the glass refracts it live.
//! The labels sitting on the glass come the same way through [`Showcase::set_labels`] and
//! are drawn between two passes of glass, so glass above them refracts them too.
//! Everything else is a thin, flat binding over [`liquid_rust::Scene`].
#![cfg(target_arch = "wasm32")]

use liquid_rust::{Color, ContainerId, Frame, Glass, GlassId, Material, Rect, Renderer, Scene, Shape, Spring, Vec2};
use wasm_bindgen::prelude::*;

/// One WebGPU canvas with a liquid-rust scene on top of page-drawn content.
#[wasm_bindgen]
pub struct Showcase {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    view_format: wgpu::TextureFormat,
    /// Draws the glass under the labels into `middle`.
    lower: Renderer,
    /// Draws the glass from layer `upper_z` up over `middle`, into the canvas.
    upper: Renderer,
    upper_z: i32,
    content: wgpu::Texture,
    content_changed: bool,
    /// Content, lower glass and its labels: what the upper glass refracts.
    middle: wgpu::Texture,
    labels: wgpu::Texture,
    ink: wgpu::RenderPipeline,
    scene: Scene,
    glass: Vec<GlassId>,
    containers: Vec<ContainerId>,
    scale: f32,
}

#[wasm_bindgen]
impl Showcase {
    /// Sets up WebGPU on `canvas` (sized in device pixels). `scale` is pixels per scene
    /// unit: `devicePixelRatio` times any page zoom.
    pub async fn create(canvas: web_sys::HtmlCanvasElement, scale: f32) -> Result<Showcase, JsValue> {
        let (width, height) = (canvas.width(), canvas.height());
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas)).map_err(|e| e.to_string())?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())?;
        let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor::default()).await.map_err(|e| e.to_string())?;
        let mut config = surface.get_default_config(&adapter, width, height).ok_or("canvas not supported")?;
        // Canvases are bgra8unorm; render through an sRGB view so linear output is encoded.
        let view_format = config.format.add_srgb_suffix();
        config.view_formats = vec![view_format];
        config.alpha_mode = wgpu::CompositeAlphaMode::Opaque;
        surface.configure(&device, &config);
        let [content, middle, labels] = textures(&device, width, height);
        Ok(Showcase {
            lower: Renderer::new(&device, MIDDLE),
            upper: Renderer::new(&device, view_format),
            upper_z: i32::MAX,
            ink: ink_pipeline(&device),
            surface,
            device,
            queue,
            config,
            view_format,
            content,
            content_changed: true,
            middle,
            labels,
            scene: Scene::new(),
            glass: Vec::new(),
            containers: Vec::new(),
            scale,
        })
    }

    /// Follows a canvas resize (device pixels) and a new scale.
    pub fn resize(&mut self, width: u32, height: u32, scale: f32) {
        let (width, height) = (width.max(1), height.max(1));
        self.scale = scale;
        if (width, height) == (self.config.width, self.config.height) {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
        [self.content, self.middle, self.labels] = textures(&self.device, width, height);
        self.content_changed = true;
    }

    /// Uploads the page's 2D canvas as the content behind the glass. Call it only when
    /// that canvas changed: an unchanged backdrop reuses its blur pyramid for free.
    #[wasm_bindgen(js_name = setContent)]
    pub fn set_content(&mut self, source: web_sys::HtmlCanvasElement) {
        self.upload(source, &self.content, false);
        self.content_changed = true;
    }

    /// Uploads the page's 2D canvas of labels and glyphs that sit on the glass below layer
    /// `upper_z`. They are drawn over that glass, and the glass from `upper_z` up refracts
    /// them: a lens over a menu bends the menu's text, not only its outline. Call it only
    /// when that canvas changed.
    #[wasm_bindgen(js_name = setLabels)]
    pub fn set_labels(&mut self, source: web_sys::HtmlCanvasElement, upper_z: i32) {
        self.upload(source, &self.labels, true);
        self.upper_z = upper_z;
    }

    /// `GlassEffectContainer(spacing:)` at layer `z`; returns its handle.
    #[wasm_bindgen(js_name = addContainer)]
    pub fn add_container(&mut self, spacing: f32, z: i32) -> u32 {
        self.containers.push(self.scene.add_container(spacing, z));
        self.containers.len() as u32 - 1
    }

    /// Merge distance of a container; `0` turns liquid merging off.
    #[wasm_bindgen(js_name = setContainerSpacing)]
    pub fn set_container_spacing(&mut self, container: u32, spacing: f32) {
        if let Some(&c) = self.containers.get(container as usize) {
            self.scene.set_container_spacing(c, spacing);
        }
    }

    /// Adds glass; it materializes by ramping its lensing in. `shape`: "capsule",
    /// "rounded" (iOS squircle), "circular" or "smooth" (Figma `smoothing` 0–1).
    /// `material`: "regular", "clear", "clear-bar", "tinted" (with `tint` 0xRRGGBB) or
    /// "identity". `container < 0` means none.
    #[expect(clippy::too_many_arguments, reason = "flat JS binding")]
    pub fn add(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        shape: &str,
        radius: f32,
        smoothing: f32,
        material: &str,
        tint: u32,
        interactive: bool,
        lens: bool,
        container: i32,
        z: i32,
    ) -> u32 {
        let glass = self.describe(x, y, w, h, shape, radius, smoothing, material, tint, interactive, lens, container, z);
        let id = self.scene.add(glass);
        self.push(id)
    }

    /// Grows new glass out of glass `source` with a `duration`/`bounce` spring: a liquid
    /// neck stretches and pinches off once the gap passes half the container spacing.
    #[wasm_bindgen(js_name = expandFrom)]
    #[expect(clippy::too_many_arguments, reason = "flat JS binding")]
    pub fn expand_from(
        &mut self,
        source: u32,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        shape: &str,
        radius: f32,
        material: &str,
        duration: f32,
        bounce: f32,
    ) -> u32 {
        let glass = self.describe(x, y, w, h, shape, radius, 0.6, material, 0, false, false, -1, 0);
        let id = match self.id(source) {
            Some(from) => self.scene.expand_from(from, glass, Spring::new(duration, bounce)),
            None => self.scene.add(glass),
        };
        self.push(id)
    }

    /// Springs glass `id` back into `target` and drops it once merged.
    #[wasm_bindgen(js_name = collapseInto)]
    pub fn collapse_into(&mut self, id: u32, target: u32, duration: f32, bounce: f32) {
        if let (Some(id), Some(target)) = (self.id(id), self.id(target)) {
            self.scene.collapse_into(id, target, Spring::new(duration, bounce));
        }
    }

    /// Morphs to a new frame with `.snappy`.
    #[wasm_bindgen(js_name = setFrame)]
    pub fn set_frame(&mut self, id: u32, x: f32, y: f32, w: f32, h: f32) {
        if let Some(id) = self.id(id) {
            self.scene.set_frame(id, Rect::new(x, y, w, h));
        }
    }

    /// Morphs to a new frame with a custom `duration`/`bounce` spring.
    #[wasm_bindgen(js_name = setFrameWith)]
    #[expect(clippy::too_many_arguments, reason = "flat JS binding")]
    pub fn set_frame_with(&mut self, id: u32, x: f32, y: f32, w: f32, h: f32, duration: f32, bounce: f32) {
        if let Some(id) = self.id(id) {
            self.scene.set_frame_with(id, Rect::new(x, y, w, h), Spring::new(duration, bounce));
        }
    }

    /// Swaps the material: a preset plus optional Figma GLASS knobs. Pass `NaN` to keep
    /// the preset's value. `tint_strength` is the stained-glass alpha.
    #[wasm_bindgen(js_name = setMaterial)]
    #[expect(clippy::too_many_arguments, reason = "flat JS binding")]
    pub fn set_material(
        &mut self,
        id: u32,
        preset: &str,
        tint: u32,
        tint_strength: f32,
        refraction: f32,
        depth: f32,
        frost: f32,
        dispersion: f32,
    ) {
        let Some(id) = self.id(id) else { return };
        let mut m = material(preset, tint);
        if let Some(t) = m.tint.as_mut().filter(|_| tint_strength.is_finite()) {
            t.a = tint_strength;
        }
        let pick = |v: f32, d: f32| if v.is_finite() { v } else { d };
        m.refraction = pick(refraction, m.refraction);
        m.depth = pick(depth, m.depth);
        m.frost = pick(frost, m.frost);
        m.dispersion = pick(dispersion, m.dispersion);
        self.scene.set_material(id, m);
    }

    /// Swaps the outline (see [`Showcase::add`] for `shape`).
    #[wasm_bindgen(js_name = setShape)]
    pub fn set_shape(&mut self, id: u32, shape: &str, radius: f32, smoothing: f32) {
        if let Some(id) = self.id(id) {
            self.scene.set_shape(id, outline(shape, radius, smoothing));
        }
    }

    /// Dematerializes glass `id`, then drops it.
    pub fn remove(&mut self, id: u32) {
        if let Some(id) = self.id(id) {
            self.scene.remove(id);
        }
    }

    /// `[x, y, w, h]` on screen right now (mid-spring), or `undefined` once dropped.
    #[wasm_bindgen(js_name = frameOf)]
    pub fn frame_of(&self, id: u32) -> Option<Vec<f32>> {
        let r = self.scene.current_frame(self.id(id)?)?;
        Some(vec![r.x, r.y, r.width, r.height])
    }

    /// Topmost interactive or lens glass under the point, or -1.
    #[wasm_bindgen(js_name = hitTest)]
    pub fn hit_test(&self, x: f32, y: f32) -> i32 {
        self.handle(self.scene.hit_test(Vec2::new(x, y)))
    }

    /// Press: grows interactive glass and lights it from the finger; picks up a lens.
    /// Returns the glass that took it, or -1.
    #[wasm_bindgen(js_name = pointerDown)]
    pub fn pointer_down(&mut self, x: f32, y: f32) -> i32 {
        let hit = self.scene.pointer_down(Vec2::new(x, y));
        self.handle(hit)
    }

    /// Pointer moved; a held lens follows and stretches with speed.
    #[wasm_bindgen(js_name = pointerMove)]
    pub fn pointer_move(&mut self, x: f32, y: f32) {
        self.scene.pointer_move(Vec2::new(x, y));
    }

    /// Release: bounce back, glow fades, a lens drops and jiggles.
    #[wasm_bindgen(js_name = pointerUp)]
    pub fn pointer_up(&mut self) {
        self.scene.pointer_up();
    }

    /// iOS 27 transparency slider (0 ultra clear … 1 tinted), dark scheme, accessibility.
    #[wasm_bindgen(js_name = setAppearance)]
    pub fn set_appearance(&mut self, transparency: f32, dark: bool, reduce_transparency: bool, increase_contrast: bool, reduce_motion: bool) {
        let a = &mut self.scene.appearance;
        a.transparency = transparency.clamp(0.0, 1.0);
        a.dark = dark;
        a.reduce_transparency = reduce_transparency;
        a.increase_contrast = increase_contrast;
        a.reduce_motion = reduce_motion;
    }

    /// Specular light direction in degrees, 0 = from the top, clockwise (springs there).
    #[wasm_bindgen(js_name = setLightAngle)]
    pub fn set_light_angle(&mut self, degrees: f32) {
        self.scene.set_light_angle(degrees);
    }

    /// `false` lands every change on the next frame: no springs, press growth or stretch.
    #[wasm_bindgen(js_name = setPhysics)]
    pub fn set_physics(&mut self, on: bool) {
        self.scene.physics = on;
    }

    /// Advances every spring by `dt` seconds. Returns `true` while anything still moves.
    /// The labels follow the glass, so the page draws them between this and [`Showcase::draw`].
    pub fn update(&mut self, dt: f32) -> bool {
        self.scene.update(dt)
    }

    /// Draws the frame: content, the lower glass, its labels, then the upper glass.
    pub fn draw(&mut self) {
        let surface_texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            _ => return,
        };
        let target = surface_texture.texture.create_view(&wgpu::TextureViewDescriptor { format: Some(self.view_format), ..Default::default() });
        let content = self.content.create_view(&Default::default());
        let middle = self.middle.create_view(&Default::default());
        let size = (self.config.width, self.config.height);
        let mut encoder = self.device.create_command_encoder(&Default::default());

        let frame = Frame { content: &content, target: &middle, size, scale: self.scale, content_changed: self.content_changed };
        self.lower.render_layers(&self.device, &self.queue, &mut encoder, &frame, &self.scene, ..self.upper_z);
        self.draw_labels(&mut encoder);
        // The lower glass is redrawn every frame, so what the upper glass sees is always new.
        let frame = Frame { content: &middle, target: &target, size, scale: self.scale, content_changed: true };
        self.upper.render_layers(&self.device, &self.queue, &mut encoder, &frame, &self.scene, self.upper_z..);

        self.queue.submit([encoder.finish()]);
        self.queue.present(surface_texture);
        self.content_changed = false;
    }

    /// [`Showcase::update`], then [`Showcase::draw`] with the labels as they are.
    pub fn frame(&mut self, dt: f32) -> bool {
        let animating = self.update(dt);
        self.draw();
        animating
    }
}

impl Showcase {
    fn upload(&self, source: web_sys::HtmlCanvasElement, texture: &wgpu::Texture, premultiplied_alpha: bool) {
        let size = wgpu::Extent3d {
            width: source.width().min(self.config.width),
            height: source.height().min(self.config.height),
            depth_or_array_layers: 1,
        };
        self.queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source: wgpu::ExternalImageSource::HTMLCanvasElement(source),
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha,
            },
            size,
        );
    }

    /// Lays the labels over the lower glass in `middle`. It blends the encoded values,
    /// through a view without the sRGB suffix, as the browser does when it composites a
    /// canvas: text keeps the weight it has in the DOM.
    fn draw_labels(&self, encoder: &mut wgpu::CommandEncoder) {
        let labels = self.labels.create_view(&Default::default());
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("labels"),
            layout: &self.ink.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&labels) }],
        });
        let encoded = self.middle.create_view(&wgpu::TextureViewDescriptor { format: Some(LABELS), ..Default::default() });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("labels"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &encoded,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.ink);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }

    fn id(&self, handle: u32) -> Option<GlassId> {
        self.glass.get(handle as usize).copied()
    }

    fn push(&mut self, id: GlassId) -> u32 {
        self.glass.push(id);
        self.glass.len() as u32 - 1
    }

    fn handle(&self, id: Option<GlassId>) -> i32 {
        id.and_then(|id| self.glass.iter().position(|&g| g == id)).map_or(-1, |i| i as i32)
    }

    #[expect(clippy::too_many_arguments, reason = "mirrors the JS binding")]
    fn describe(
        &self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        shape: &str,
        radius: f32,
        smoothing: f32,
        material_name: &str,
        tint: u32,
        interactive: bool,
        lens: bool,
        container: i32,
        z: i32,
    ) -> Glass {
        let mut glass = Glass::new(Rect::new(x, y, w, h)).shape(outline(shape, radius, smoothing)).material(material(material_name, tint)).z(z);
        if interactive {
            glass = glass.interactive();
        }
        if lens {
            glass = glass.lens();
        }
        if let Some(&c) = usize::try_from(container).ok().and_then(|c| self.containers.get(c)) {
            glass = glass.container(c);
        }
        glass
    }
}

fn material(name: &str, tint: u32) -> Material {
    match name {
        "clear" => Material::clear(),
        "clear-bar" => Material::clear_bar(),
        "tinted" => Material::tinted(Color::hex(tint)),
        "identity" => Material::identity(),
        _ => Material::regular(),
    }
}

fn outline(shape: &str, radius: f32, smoothing: f32) -> Shape {
    match shape {
        "rounded" => Shape::Rounded(radius),
        "circular" => Shape::Circular(radius),
        "smooth" => Shape::Smooth { radius, smoothing },
        _ => Shape::Capsule,
    }
}

/// Format of `middle`, read by the glass as linear colour.
const MIDDLE: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
/// Format of the labels, and of the view of `middle` they are blended through.
const LABELS: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// The content, middle and labels textures for a canvas of this size.
fn textures(device: &wgpu::Device, width: u32, height: u32) -> [wgpu::Texture; 3] {
    let texture = |label, format, view_formats: &[wgpu::TextureFormat]| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats,
        })
    };
    [texture("content", MIDDLE, &[]), texture("middle", MIDDLE, &[LABELS]), texture("labels", LABELS, &[])]
}

/// Copies the premultiplied labels over whatever is in the target.
fn ink_pipeline(device: &wgpu::Device) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("labels"),
        source: wgpu::ShaderSource::Wgsl(
            "@group(0) @binding(0) var labels: texture_2d<f32>;
            @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
                return vec4f(vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0, 0.0, 1.0);
            }
            @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
                return textureLoad(labels, vec2i(p.xy), 0);
            }"
            .into(),
        ),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("labels"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: LABELS,
                blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}
