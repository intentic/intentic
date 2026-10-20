//! The JNI functions `dev.intentic.app.core.Core` binds by name. Events go to the app's listener from one thread of
//! their own, attached to the JVM once, so a core thread never waits on Kotlin and never attaches per event.

use super::{Config, Event, Request};
use crate::core::Core;
use jni::objects::{GlobalRef, JClass, JObject, JObjectArray, JString, JValue};
use jni::sys::{jint, jintArray};
use jni::{JNIEnv, JavaVM};
use std::path::Path;
use std::sync::mpsc::{self, Receiver};

fn throw(env: &mut JNIEnv, message: &str) {
    let _ = env.throw_new("java/lang/IllegalStateException", message);
}

fn text(env: &mut JNIEnv, value: &JString) -> Result<String, String> {
    env.get_string(value)
        .map(String::from)
        .map_err(|error| error.to_string())
}

/// `text` for the functions a list calls per row. The checked `get_string` looks `java.lang.String` up on every call,
/// 0.85µs of a row's 2µs on a Galaxy S10 (`../android-native/README.md`, "Bridge: JNI or JNA").
fn row_text(env: &mut JNIEnv, value: &JString) -> Result<String, String> {
    if value.is_null() {
        return Err("null".into());
    }
    // SAFETY: `value` is a non-null parameter Kotlin declared `String`, so the JVM only ever passes a java.lang.String.
    unsafe { env.get_string_unchecked(value) }
        .map(String::from)
        .map_err(|error| error.to_string())
}

/// `Core.start(dataDir, configJson, listener)`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_app_core_Core_start<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    data_dir: JString<'local>,
    config: JString<'local>,
    listener: JObject<'local>,
) {
    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default()
            .with_tag("IntenticCore")
            .with_max_level(log::LevelFilter::Info),
    );
    let started = (|| -> Result<(), String> {
        let data_dir = text(&mut env, &data_dir)?;
        let config: Config =
            serde_json::from_str(&text(&mut env, &config)?).map_err(|error| error.to_string())?;
        if Core::get().is_some() {
            return Ok(());
        }
        let vm = env.get_java_vm().map_err(|error| error.to_string())?;
        let listener = env
            .new_global_ref(listener)
            .map_err(|error| error.to_string())?;
        let (sender, receiver) = mpsc::channel::<Event>();
        std::thread::Builder::new()
            .name("core-events".into())
            .spawn(move || deliver(vm, listener, receiver))
            .map_err(|error| error.to_string())?;
        Core::start(Path::new(&data_dir), config, move |event| {
            let _ = sender.send(event);
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
    })();
    if let Err(message) = started {
        throw(&mut env, &message);
    }
}

fn deliver(vm: JavaVM, listener: GlobalRef, events: Receiver<Event>) {
    let Ok(mut env) = vm.attach_current_thread_as_daemon() else {
        log::error!("the event thread could not attach to the JVM");
        return;
    };
    for event in events {
        let Ok(json) = serde_json::to_string(&event) else {
            continue;
        };
        let Ok(json) = env.new_string(json) else {
            continue;
        };
        let called = env.call_method(
            listener.as_obj(),
            "onEvent",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&json)],
        );
        let _ = env.delete_local_ref(json);
        if called.is_err() && env.exception_check().unwrap_or(false) {
            // A listener that threw is the app's bug: log it and keep the core's events flowing.
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
    }
}

/// `Core.call(requestJson)`: the call's number, or -1 (with an exception thrown) when the core is not running or the
/// JSON is not a request.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_app_core_Core_call<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    request: JString<'local>,
) -> jint {
    let Some(core) = Core::get() else {
        throw(&mut env, "the core has not started");
        return -1;
    };
    let request = match text(&mut env, &request)
        .and_then(|json| serde_json::from_str::<Request>(&json).map_err(|error| error.to_string()))
    {
        Ok(request) => request,
        Err(message) => {
            throw(&mut env, &format!("not a request: {message}"));
            return -1;
        }
    };
    core.call(request)
}

/// `Core.rowCount(agent)`: how many rows `agent`'s open conversation holds; 0 when it is not open.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_app_core_Core_rowCount<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    agent: JString<'local>,
) -> jint {
    let Ok(agent) = row_text(&mut env, &agent) else {
        return 0;
    };
    Core::get()
        .and_then(|core| core.conversation(&agent))
        .and_then(|rows| rows.lock().ok().map(|rows| rows.len() as jint))
        .unwrap_or(0)
}

/// `Core.row(agent, index, out)`: row `index` drawn. Its text goes into `out[0]`; the answer is `[kind, start, end,
/// kind, arg, ...]`, the row's view kind (`conversation::row::KIND_*`) then its span quads. Null, with `out[0]`
/// untouched, for a row that is not there (the list read past a change it has not been told yet).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_app_core_Core_row<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    agent: JString<'local>,
    index: jint,
    out: JObjectArray<'local>,
) -> jintArray {
    let Ok(agent) = row_text(&mut env, &agent) else {
        return std::ptr::null_mut();
    };
    let rendered = Core::get()
        .and_then(|core| core.conversation(&agent))
        .and_then(|rows| crate::conversation::read(&rows, usize::try_from(index).ok()?));
    let Some(rendered) = rendered else {
        return std::ptr::null_mut();
    };
    let (kind, rendered) = rendered.as_ref();
    let Ok(text) = env.new_string(&rendered.text) else {
        return std::ptr::null_mut();
    };
    if env.set_object_array_element(&out, 0, &text).is_err() {
        return std::ptr::null_mut();
    }
    let mut ints = Vec::with_capacity(rendered.spans.len() + 1);
    ints.push(*kind);
    ints.extend_from_slice(&rendered.spans);
    let Ok(array) = env.new_int_array(ints.len() as i32) else {
        return std::ptr::null_mut();
    };
    if env.set_int_array_region(&array, 0, &ints).is_err() {
        return std::ptr::null_mut();
    }
    array.into_raw()
}

/// `Core.card(agent, index)`: what row `index`'s card buttons need, as `CardRow` JSON; null for a row with no card.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_app_core_Core_card<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    agent: JString<'local>,
    index: jint,
) -> jni::sys::jstring {
    let Ok(agent) = row_text(&mut env, &agent) else {
        return std::ptr::null_mut();
    };
    let card = Core::get()
        .and_then(|core| core.conversation(&agent))
        .and_then(|rows| rows.lock().ok()?.card(usize::try_from(index).ok()?));
    let Some(json) = card.and_then(|card| serde_json::to_string(&card).ok()) else {
        return std::ptr::null_mut();
    };
    env.new_string(json)
        .map_or(std::ptr::null_mut(), |json| json.into_raw())
}

/// `Core.pageId(agent, index)`: the page id of a row of kind page (4), for the web's
/// `/agents/<agent>/pages/<pageId>`; null for any other row.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_app_core_Core_pageId<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    agent: JString<'local>,
    index: jint,
) -> jni::sys::jstring {
    let Ok(agent) = text(&mut env, &agent) else {
        return std::ptr::null_mut();
    };
    let id = Core::get()
        .and_then(|core| core.conversation(&agent))
        .and_then(|rows| rows.lock().ok()?.page_id(usize::try_from(index).ok()?));
    let Some(id) = id else {
        return std::ptr::null_mut();
    };
    env.new_string(id)
        .map_or(std::ptr::null_mut(), |id| id.into_raw())
}
