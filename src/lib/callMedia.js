// Pure media helpers for voice/video calling: constraint building, the quality
// ladder the adaptation loop walks, and stats reduction. Deliberately free of
// React and of any direct browser call so the policies can be unit tested — the
// caller passes in whatever `getStats()` produced.

export const QUALITY_TIERS = [
  { name: 'low', width: 320, height: 180, frameRate: 15, maxBitrate: 150000 },
  { name: 'medium', width: 640, height: 360, frameRate: 24, maxBitrate: 500000 },
  { name: 'high', width: 1280, height: 720, frameRate: 30, maxBitrate: 1500000 },
]

export const DEFAULT_QUALITY = 'medium'

// Thresholds are deliberately asymmetric (start degrading early, recover late)
// so the ladder does not oscillate around a single boundary value.
const BAD_LOSS_PCT = 8
const GOOD_LOSS_PCT = 2
const BAD_RTT_MS = 400
const GOOD_RTT_MS = 150
const LOW_BITRATE = 250000
const HIGH_BITRATE = 1200000

export function isTierName(value) {
  return QUALITY_TIERS.some((tier) => tier.name === value)
}

export function tierByName(name) {
  return QUALITY_TIERS.find((tier) => tier.name === name) || QUALITY_TIERS.find((tier) => tier.name === DEFAULT_QUALITY)
}

// Move one rung up or down the ladder, clamped at both ends.
export function stepTier(name, direction) {
  const index = QUALITY_TIERS.indexOf(tierByName(name))
  const next = Math.min(Math.max(index + Math.sign(direction || 0), 0), QUALITY_TIERS.length - 1)
  return QUALITY_TIERS[next].name
}

export function buildAudioConstraints() {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
}

export function buildVideoConstraints(name = DEFAULT_QUALITY, { facingMode = 'user' } = {}) {
  const tier = tierByName(name)
  return {
    width: { ideal: tier.width },
    height: { ideal: tier.height },
    frameRate: { ideal: tier.frameRate, max: tier.frameRate },
    facingMode,
  }
}

// `video: false` keeps a voice call from ever prompting for (or holding) the
// camera, which is what keeps the voice path byte-for-byte what it was.
export function buildMediaConstraints({ kind = 'voice', tier = DEFAULT_QUALITY, facingMode } = {}) {
  const constraints = { audio: buildAudioConstraints(), video: false }
  if (kind === 'video') constraints.video = buildVideoConstraints(tier, { facingMode })
  return constraints
}

// The mutation handed to RTCRtpSender.setParameters / the native plugin.
export function qualityEncodingParams(nameOrTier) {
  const tier = typeof nameOrTier === 'string'
    ? tierByName(nameOrTier)
    : tierByName(nameOrTier?.name)
  return { maxBitrate: tier.maxBitrate, maxFramerate: tier.frameRate }
}

function toEntries(report) {
  if (!report) return []
  if (Array.isArray(report)) return report
  if (typeof report.forEach === 'function') {
    const out = []
    report.forEach((value) => { out.push(value) })
    return out
  }
  if (typeof report[Symbol.iterator] === 'function') return Array.from(report)
  return []
}

function finite(value) {
  return Number.isFinite(value) ? value : null
}

// Reduces a stats report (RTCStatsReport, its Map shim, or a plain array) to the
// handful of numbers the adaptation loop actually uses.
export function summarizeStats(report) {
  const entries = toEntries(report)
  let rttMs = null
  let availableOutgoingBitrate = null
  let packetsLost = 0
  let packetsReceived = 0
  let framesPerSecond = null
  let qualityLimitationReason = ''
  let outboundBytesSent = 0

  for (const stat of entries) {
    if (!stat || typeof stat !== 'object') continue

    if (stat.type === 'candidate-pair' && (stat.state === 'succeeded' || stat.nominated)) {
      const rtt = finite(stat.currentRoundTripTime)
      if (rtt !== null) rttMs = Math.round(rtt * 1000)
      const available = finite(stat.availableOutgoingBitrate)
      if (available !== null) availableOutgoingBitrate = available
    }

    if (stat.type === 'inbound-rtp' && !stat.isRemote) {
      const lost = finite(stat.packetsLost)
      if (lost !== null) packetsLost += Math.max(lost, 0)
      const received = finite(stat.packetsReceived)
      if (received !== null) packetsReceived += Math.max(received, 0)
      if (stat.kind === 'video') {
        const fps = finite(stat.framesPerSecond)
        if (fps !== null) framesPerSecond = fps
        if (typeof stat.qualityLimitationReason === 'string') qualityLimitationReason = stat.qualityLimitationReason
      }
    }

    if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
      const sent = finite(stat.bytesSent)
      if (sent !== null) outboundBytesSent = sent
      if (!qualityLimitationReason && typeof stat.qualityLimitationReason === 'string') {
        qualityLimitationReason = stat.qualityLimitationReason
      }
    }
  }

  const totalPackets = packetsLost + packetsReceived
  // `null` (rather than 0) means "no packet data yet", which the adaptation loop
  // must not read as a perfect link.
  const lossPct = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : null

  return { rttMs, availableOutgoingBitrate, lossPct, framesPerSecond, qualityLimitationReason, outboundBytesSent }
}

// Returns the tier the next tuning tick should use. One rung per tick keeps the
// picture stable instead of snapping between the floor and the ceiling, and a
// report with no usable signal holds the current tier rather than guessing.
export function selectQuality(currentName, metrics = {}) {
  const current = tierByName(currentName)
  const lossPct = finite(metrics.lossPct)
  const rttMs = finite(metrics.rttMs)
  const available = finite(metrics.availableOutgoingBitrate)
  const reason = metrics.qualityLimitationReason || ''

  if (lossPct === null && rttMs === null && available === null && !reason) return current.name

  const congested =
    (lossPct !== null && lossPct >= BAD_LOSS_PCT) ||
    (rttMs !== null && rttMs >= BAD_RTT_MS) ||
    (available !== null && available < LOW_BITRATE) ||
    reason === 'bandwidth' ||
    reason === 'cpu'

  if (congested) return stepTier(current.name, -1)

  const healthy =
    lossPct !== null &&
    lossPct < GOOD_LOSS_PCT &&
    (rttMs === null || rttMs < GOOD_RTT_MS) &&
    (available === null || available > HIGH_BITRATE) &&
    reason !== 'bandwidth' &&
    reason !== 'cpu'

  if (healthy) return stepTier(current.name, 1)

  return current.name
}
