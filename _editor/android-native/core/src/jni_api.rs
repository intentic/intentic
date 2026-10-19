//! The functions `dev.intentic.spike.Core` (Kotlin) declares `external`. A conversation is a boxed `Shared` whose
//! address is the `long` handle Kotlin keeps; `close` frees it. Errors become a `RuntimeException` in Kotlin.

use crate::render::{render, warm};
use crate::{Conversation, Shared};
use jni::JNIEnv;
use jni::objects::{JClass, JObjectArray, JString};
use jni::sys::{jboolean, jint, jintArray, jlong};
use std::sync::Mutex;

fn shared<'a>(handle: jlong) -> &'a Shared {
    // SAFETY: `handle` is a pointer `open` leaked from a `Box<Shared>` and `close` has not freed it yet: Kotlin's
    // `NativeConversation` owns it and closes it once.
    unsafe { &*(handle as *const Shared) }
}

fn throw(env: &mut JNIEnv, message: &str) {
    let _ = env.throw_new("java/lang/RuntimeException", message);
}

fn int_array(env: &mut JNIEnv, values: &[i32]) -> jintArray {
    match env.new_int_array(values.len() as i32) {
        Ok(array) => {
            if env.set_int_array_region(&array, 0, values).is_err() {
                throw(env, "could not fill an int[]");
            }
            array.into_raw()
        }
        Err(_) => std::ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_Core_warm(_env: JNIEnv, _class: JClass) {
    warm();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_Core_open(
    mut env: JNIEnv,
    _class: JClass,
    fixture: JString,
    rows: jint,
) -> jlong {
    let fixture: String = match env.get_string(&fixture) {
        Ok(text) => text.into(),
        Err(_) => {
            throw(&mut env, "the fixture is not a string");
            return 0;
        }
    };
    match Conversation::open(&fixture, rows.max(1) as usize) {
        Ok(conversation) => Box::into_raw(Box::new(Shared(Mutex::new(conversation)))) as jlong,
        Err(error) => {
            throw(&mut env, &error.to_string());
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_Core_close(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if handle != 0 {
        // SAFETY: see `shared`; Kotlin calls close once and drops the handle.
        drop(unsafe { Box::from_raw(handle as *mut Shared) });
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_Core_count(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    shared(handle)
        .0
        .lock()
        .map_or(0, |conversation| conversation.rows().len() as jint)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_Core_role(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    index: jint,
) -> jint {
    shared(handle)
        .0
        .lock()
        .ok()
        .and_then(|conversation| {
            conversation
                .rows()
                .get(index as usize)
                .map(|row| row.role as jint)
        })
        .unwrap_or(-1)
}

/// The row's text goes into `out[0]`; the return value is its spans as `[start, end, kind, arg]` quads.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_Core_render<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    handle: jlong,
    index: jint,
    out: JObjectArray<'local>,
) -> jintArray {
    let row = shared(handle)
        .0
        .lock()
        .ok()
        .and_then(|conversation| conversation.rows().get(index as usize).cloned());
    let Some(row) = row else {
        throw(&mut env, &format!("no row {index}"));
        return std::ptr::null_mut();
    };
    let rendered = render(&row);
    let text = match env.new_string(&rendered.text) {
        Ok(text) => text,
        Err(_) => return std::ptr::null_mut(),
    };
    if env.set_object_array_element(&out, 0, &text).is_err() {
        return std::ptr::null_mut();
    }
    int_array(&mut env, &rendered.spans)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_Core_appendUser(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    text: JString,
) -> jint {
    let text: String = match env.get_string(&text) {
        Ok(text) => text.into(),
        Err(_) => return -1,
    };
    shared(handle).0.lock().map_or(-1, |mut conversation| {
        conversation.append_user(&text) as jint
    })
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_Core_streamStart(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    now_ms: jlong,
    duration_ms: jlong,
) {
    if let Ok(mut conversation) = shared(handle).0.lock() {
        conversation.stream_start(now_ms.max(0) as u64, duration_ms.max(0) as u64);
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_Core_streaming(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jboolean {
    shared(handle)
        .0
        .lock()
        .map_or(0, |conversation| u8::from(conversation.streaming()))
}

/// The rows the turn changed or added since the last tick; the caller compares `count` to tell the added ones.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_spike_Core_streamTick(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    now_ms: jlong,
) -> jintArray {
    let changed: Vec<i32> = shared(handle).0.lock().map_or_else(
        |_| Vec::new(),
        |mut conversation| {
            conversation
                .stream_tick(now_ms.max(0) as u64)
                .into_iter()
                .map(|index| index as i32)
                .collect()
        },
    );
    int_array(&mut env, &changed)
}
