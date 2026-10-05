package dev.intentic.device

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals

/** Structural JSON equality: key order does not matter, and 5, 5L and 5.0 are the same number. */
object JsonAssert {
    fun same(expected: Any?, actual: Any?, path: String = "$") {
        when {
            expected is JSONObject && actual is JSONObject -> {
                assertEquals("keys at $path", expected.keys().asSequence().toSet(), actual.keys().asSequence().toSet())
                for (key in expected.keys()) {
                    same(expected.get(key), actual.get(key), "$path.$key")
                }
            }
            expected is JSONArray && actual is JSONArray -> {
                assertEquals("length at $path", expected.length(), actual.length())
                for (index in 0 until expected.length()) {
                    same(expected.get(index), actual.get(index), "$path[$index]")
                }
            }
            expected is Number && actual is Number -> assertEquals("number at $path", expected.toDouble(), actual.toDouble(), 0.0)
            expected == JSONObject.NULL || actual == JSONObject.NULL -> assertEquals("null at $path", expected == JSONObject.NULL, actual == JSONObject.NULL)
            else -> assertEquals("value at $path", expected, actual)
        }
    }
}
