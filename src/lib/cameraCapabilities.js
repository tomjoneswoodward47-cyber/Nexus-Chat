export function cameraConstraints(facingMode = 'environment') {
  return {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
  }
}

export function cameraTrackFeatures(track) {
  const capabilities = track?.getCapabilities?.() || {}
  const settings = track?.getSettings?.() || {}
  const focusModes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : []
  const focusDistanceRange = capabilities.focusDistance
  return {
    width: settings.width || 0,
    height: settings.height || 0,
    frameRate: settings.frameRate || 0,
    facingMode: settings.facingMode || '',
    torch: capabilities.torch === true,
    torchEnabled: false,
    focusModes,
    focusDistanceRange,
    focusDistance: settings.focusDistance ?? focusDistanceRange?.max ?? 0,
    continuousFocus: focusModes.includes('continuous'),
  }
}

export async function applyCameraTorch(track, enabled) {
  const features = cameraTrackFeatures(track)
  if (!features.torch || typeof track?.applyConstraints !== 'function') return false
  await track.applyConstraints({ advanced: [{ torch: Boolean(enabled) }] })
  return true
}

export async function applyCameraFocus(track, mode = 'continuous') {
  const features = cameraTrackFeatures(track)
  if (!features.focusModes.includes(mode) || typeof track?.applyConstraints !== 'function') return false
  await track.applyConstraints({ advanced: [{ focusMode: mode }] })
  return true
}

export async function applyCameraFocusDistance(track, distance) {
  const features = cameraTrackFeatures(track)
  const range = features.focusDistanceRange
  if (!features.focusModes.includes('manual') || !range || typeof track?.applyConstraints !== 'function') return false
  const nextDistance = Math.min(range.max, Math.max(range.min, Number(distance)))
  await track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: nextDistance }] })
  return true
}

export function createCameraFile(blob, name, now = Date.now()) {
  const extension = blob.type === 'video/webm' ? 'webm' : blob.type === 'video/mp4' ? 'mp4' : 'jpg'
  const fileName = name || `camera-${now}.${extension}`
  if (typeof File === 'function') return new File([blob], fileName, { type: blob.type || 'application/octet-stream' })
  blob.name = fileName
  return blob
}
