package com.nexus.call

/**
 * The video quality ladder.
 *
 * This mirrors `src/lib/callMedia.js` on the JavaScript side so the in-app
 * WebRTC engine and the native engine agree on what "low", "medium" and "high"
 * mean. Keep the two tables in step when either one changes.
 *
 * Deliberately free of Android and WebRTC types so it can be unit tested on the
 * JVM.
 */
internal object CallQuality {

    data class Tier(
        val name: String,
        val width: Int,
        val height: Int,
        val frameRate: Int,
        val maxBitrate: Int,
    )

    const val DEFAULT = "medium"

    private val TIERS = listOf(
        Tier("low", 320, 180, 15, 150_000),
        Tier("medium", 640, 360, 24, 500_000),
        Tier("high", 1280, 720, 30, 1_500_000),
    )

    /**
     * An absent or unknown name falls back to the default tier rather than to
     * "video off", so a bad parameter can never leave the call without video.
     */
    fun of(name: String?): Tier {
        val wanted = name?.trim()?.lowercase()
        return TIERS.firstOrNull { it.name == wanted } ?: TIERS.first { it.name == DEFAULT }
    }

    fun names(): List<String> = TIERS.map { it.name }
}
