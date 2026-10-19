//! The functions `dev.intentic.spike.SurfaceCore` (Kotlin) declares `external`. A renderer is a boxed [`Renderer`]
//! whose address is the `long` handle Kotlin keeps; `detach` frees it. All but `warm` run on the main thread.

use super::{Renderer, prepare};
use crate::Shared;
use jni::JNIEnv;
use jni::objects::{JClass, JFloatArray, JObject};
use jni::sys::{jfloat, jint, jlong, jstring};
use ndk::native_window::NativeWindow;
use wgpu::rwh::{DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, WindowHandle};

/// The `SurfaceView`'s window as wgpu takes one; an Android app has the one display.
struct Window(NativeWindow);

impl HasWindowHandle for Window {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        self.0.window_handle()
    }
}

impl HasDisplayHandle for Window {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        Ok(DisplayHandle::android())
    }
}

fn logging() {
    let filter = env_filter::Builder::new()
        .filter_level(log::LevelFilter::Warn)
        .filter_module("intentic_mobile_core", log::LevelFilter::Info)
        .build();
    android_logger::init_once(
        android_logger::Config::default()
            .with_tag("SpikeSurface")
            .with_max_level(log::LevelFilter::Info)
            .with_filter(filter),
    );
}

fn renderer<'a>(handle: jlong) -> &'a mut Renderer {
    // SAFETY: `handle` is a pointer `attach` leaked from a `Box<Renderer>` and `detach` has not freed it yet; Kotlin
    // calls in only from the main thread, so no two calls hold it at once.
    unsafe { &mut *(handle as *mut Renderer) }
}

fn throw(env: &mut JNIEnv, message: &str) {
    let _ = env.throw_new("java/lang/RuntimeException", message);
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_SurfaceCore_warm(_env: JNIEnv, _class: JClass) {
    logging();
    prepare();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_SurfaceCore_attach(
    mut env: JNIEnv,
    _class: JClass,
    conversation: jlong,
    surface: JObject,
    width: jint,
    height: jint,
    density: jfloat,
    font_scale: jfloat,
) -> jlong {
    logging();
    if conversation == 0 {
        throw(&mut env, "no conversation");
        return 0;
    }
    // SAFETY: `env` and `surface` are this call's own live JNI arguments, `surface` an android.view.Surface.
    let window = unsafe { NativeWindow::from_surface(env.get_raw(), surface.as_raw()) };
    let Some(window) = window else {
        throw(&mut env, "the Surface has no native window");
        return 0;
    };
    // SAFETY: `conversation` is a handle `Core.open` made; Kotlin detaches the renderer before it closes it.
    let renderer = unsafe {
        Renderer::new(
            conversation as *const Shared,
            || Window(window.clone()),
            width.max(1) as u32,
            height.max(1) as u32,
            density,
            font_scale,
        )
    };
    match renderer {
        Ok(renderer) => Box::into_raw(Box::new(renderer)) as jlong,
        Err(error) => {
            throw(&mut env, &format!("no GPU to draw with: {error}"));
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_SurfaceCore_describe(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jstring {
    env.new_string(renderer(handle).describe())
        .map_or(std::ptr::null_mut(), |text| text.into_raw())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_SurfaceCore_resize(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    width: jint,
    height: jint,
) {
    renderer(handle).resize(width.max(1) as u32, height.max(1) as u32);
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_SurfaceCore_changed(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    index: jint,
) {
    if index >= 0 {
        renderer(handle).changed(index as usize);
    }
}

/// Draws a frame at `scroll` pixels up from the bottom. `out` gets the offset used, the largest offset, whether the
/// offset was clamped (1) and whether to draw again (1); the return value is how many rows were presented.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_SurfaceCore_frame(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    scroll: jfloat,
    out: JFloatArray,
) -> jint {
    let frame = renderer(handle).frame(scroll);
    let flag = |value: bool| if value { 1.0 } else { 0.0 };
    let values = [
        frame.scroll,
        frame.max_scroll,
        flag(frame.clamped),
        flag(frame.again),
    ];
    if env.set_float_array_region(&out, 0, &values).is_err() {
        throw(&mut env, "out must hold 4 floats");
    }
    frame.drawn as jint
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_SurfaceCore_detach(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if handle != 0 {
        // SAFETY: see `renderer`; Kotlin calls detach once and drops the handle.
        drop(unsafe { Box::from_raw(handle as *mut Renderer) });
    }
}
