package dev.intentic.device.tools

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.floor

/**
 * Checks a call's arguments against the tool's own `inputSchema`, so what `tools/list` says and what a call is held to
 * cannot drift. It reads the subset the tools use: object properties, `required`, `additionalProperties: false`, and
 * per property `type` (string, integer, number, boolean, array of integers), `enum`, `minimum`, `minItems` and `maxItems`. Answers null when valid, otherwise one
 * line a model can read to fix its call.
 */
object Schema {
    fun check(schema: JSONObject, args: JSONObject): String? {
        val problems = mutableListOf<String>()
        val properties = schema.optJSONObject("properties") ?: JSONObject()
        val required = schema.optJSONArray("required")
        if (required != null) {
            for (index in 0 until required.length()) {
                val key = required.getString(index)
                if (!args.has(key) || args.isNull(key)) {
                    problems += "\"$key\" is required"
                }
            }
        }
        val keys = args.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val property = properties.optJSONObject(key)
            if (property == null) {
                if (schema.optBoolean("additionalProperties", true).not()) {
                    problems += "\"$key\" is not an argument of this tool"
                }
                continue
            }
            if (args.isNull(key)) {
                continue
            }
            problems += problemsOf(key, property, args.get(key))
        }
        return if (problems.isEmpty()) null else "Invalid arguments: ${problems.joinToString("; ")}."
    }

    private fun arrayProblems(key: String, property: JSONObject, value: JSONArray): List<String> {
        val problems = mutableListOf<String>()
        val min = property.optInt("minItems", 0)
        val max = property.optInt("maxItems", Int.MAX_VALUE)
        if (value.length() < min || value.length() > max) {
            problems += if (min == max) "\"$key\" must have exactly $min items" else "\"$key\" must have between $min and $max items"
        }
        if (property.optJSONObject("items")?.optString("type") == "integer") {
            for (index in 0 until value.length()) {
                val item = value.get(index)
                if (!(item is Number && item.toDouble() == floor(item.toDouble()))) {
                    problems += "\"$key\" must hold integers"
                    break
                }
            }
        }
        return problems
    }

    private fun problemsOf(key: String, property: JSONObject, value: Any): List<String> {
        val type = property.optString("type", "")
        val wrongType = when (type) {
            "string" -> value !is String
            "integer" -> !(value is Number && value.toDouble() == floor(value.toDouble()))
            "number" -> value !is Number
            "boolean" -> value !is Boolean
            "array" -> value !is JSONArray
            else -> false
        }
        if (wrongType) {
            val article = if (type == "integer" || type == "array") "an" else "a"
            return listOf("\"$key\" must be $article $type")
        }
        if (value is JSONArray) {
            return arrayProblems(key, property, value)
        }
        val problems = mutableListOf<String>()
        val allowed = property.optJSONArray("enum")
        if (allowed != null) {
            val values = (0 until allowed.length()).map { allowed.get(it) }
            if (value !in values) {
                problems += "\"$key\" must be one of ${values.joinToString(", ") { "\"$it\"" }}"
            }
        }
        if (property.has("minimum") && value is Number && value.toDouble() < property.getDouble("minimum")) {
            problems += "\"$key\" must be at least ${property.get("minimum")}"
        }
        return problems
    }
}
