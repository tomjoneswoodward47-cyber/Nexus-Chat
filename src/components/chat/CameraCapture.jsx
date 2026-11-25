import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, CircleStop, Flashlight, FlipHorizontal, Focus, Video } from 'lucide-react'
import {
  applyCameraFocus,
  applyCameraFocusDistance,
  applyCameraTorch,
  cameraConstraints,
  cameraTrackFeatures,
  createCameraFile,
} from '../../lib/cameraCapabilities'

const MAX_RECORDING_MS = 45000

function chooseRecordingType() {
  if (typeof MediaRecorder === 'undefined') return ''
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
    .find((type) => MediaRecorder.isTypeSupported?.(type)) || ''
}

export default function CameraCapture({ onCapture, onClose, allowVideo = false, facingMode: initialFacingMode = 'environment' }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const cameraRequestRef = useRef(0)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const recordingTimeoutRef = useRef(null)
  const discardRecordingRef = useRef(false)
  const [facingMode, setFacingMode] = useState(initialFacingMode)
  const [features, setFeatures] = useState(null)
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const track = () => streamRef.current?.getVideoTracks?.()[0]

  const stopCamera = useCallback(() => {
    cameraRequestRef.current += 1
    streamRef.current?.getTracks?.().forEach((item) => item.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const startCamera = useCallback(async (direction = initialFacingMode) => {
    const requestId = cameraRequestRef.current + 1
    cameraRequestRef.current = requestId
    let nextStream = null
    const previousStream = streamRef.current
    setBusy(true)
    setError('')
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not available in this browser.')
      nextStream = await navigator.mediaDevices.getUserMedia(cameraConstraints(direction))
      if (requestId !== cameraRequestRef.current) {
        nextStream.getTracks?.().forEach((item) => item.stop())
        return false
      }
      if (videoRef.current) {
        videoRef.current.srcObject = nextStream
        await videoRef.current.play()
      }
      streamRef.current = nextStream
      previousStream?.getTracks?.().forEach((item) => item.stop())
      setFeatures(cameraTrackFeatures(nextStream.getVideoTracks()[0]))
      return true
    } catch (cameraError) {
      nextStream?.getTracks?.().forEach((item) => item.stop())
      if (requestId === cameraRequestRef.current) {
        if (videoRef.current) videoRef.current.srcObject = previousStream || null
        if (previousStream && videoRef.current) videoRef.current.play().catch(() => {})
        setError(cameraError?.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access in device settings and try again.'
          : cameraError?.message || 'The camera could not be started.')
      }
      return false
    } finally {
      if (requestId === cameraRequestRef.current) setBusy(false)
    }
  }, [initialFacingMode])

  useEffect(() => {
    startCamera(initialFacingMode)
    return () => {
      window.clearTimeout(recordingTimeoutRef.current)
      if (recorderRef.current?.state === 'recording') {
        discardRecordingRef.current = true
        recorderRef.current.stop()
      }
      stopCamera()
    }
  }, [initialFacingMode, startCamera, stopCamera])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !recording) onClose?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, recording])

  const switchCamera = async () => {
    if (recording) return
    const next = facingMode === 'user' ? 'environment' : 'user'
    if (await startCamera(next)) setFacingMode(next)
  }

  const capturePhoto = async () => {
    const video = videoRef.current
    if (!video?.videoWidth || !video.videoHeight || busy) return
    setError('')
    setBusy(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Photo capture is not supported by this browser.')
      context.drawImage(video, 0, 0)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
      if (!blob) throw new Error('The photo could not be captured. Try again.')
      await onCapture?.(createCameraFile(blob, `camera-${Date.now()}.jpg`))
      onClose?.()
    } catch (captureError) {
      setError(captureError?.message || 'The photo could not be captured.')
    } finally {
      setBusy(false)
    }
  }

  const finishRecording = () => {
    window.clearTimeout(recordingTimeoutRef.current)
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
  }

  const startRecording = () => {
    if (typeof MediaRecorder === 'undefined') {
      setError('Video recording is not supported in this browser.')
      return
    }
    const stream = streamRef.current
    if (!stream) return
    setError('')
    chunksRef.current = []
    try {
      const mimeType = chooseRecordingType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => { if (event.data?.size) chunksRef.current.push(event.data) }
      recorder.onerror = () => {
        setRecording(false)
        setError('Video recording failed. Check available storage and try again.')
      }
      recorder.onstop = async () => {
        if (discardRecordingRef.current) {
          discardRecordingRef.current = false
          return
        }
        setRecording(false)
        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' })
          if (!blob.size) throw new Error('No video data was captured.')
          await onCapture?.(createCameraFile(blob, `camera-${Date.now()}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`))
          onClose?.()
        } catch (recordingError) {
          setError(recordingError?.message || 'The video could not be saved.')
        }
      }
      recorder.start(250)
      setRecording(true)
      recordingTimeoutRef.current = window.setTimeout(finishRecording, MAX_RECORDING_MS)
    } catch (recordingError) {
      setError(recordingError?.message || 'Video recording could not start.')
    }
  }

  const toggleTorch = async () => {
    try {
      const applied = await applyCameraTorch(track(), !features?.torchEnabled)
      if (!applied) return
      setFeatures((current) => ({ ...current, torchEnabled: !current?.torchEnabled }))
    } catch {
      setError('The camera flash could not be changed on this device.')
    }
  }

  const setContinuousFocus = async () => {
    try {
      const applied = await applyCameraFocus(track(), 'continuous')
      if (applied) setFeatures((current) => ({ ...current, focused: true }))
    } catch {
      setError('Continuous focus is unavailable. The camera will use its automatic focus.')
    }
  }

  const setManualFocus = async (event) => {
    try {
      const focusDistance = Number(event.target.value)
      const applied = await applyCameraFocusDistance(track(), focusDistance)
      if (applied) setFeatures((current) => ({ ...current, focusDistance }))
    } catch {
      setError('The selected focus could not be applied. Automatic focus will continue.')
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="camera-capture-title" className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-4 text-foreground">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="camera-capture-title" className="font-semibold">Camera</h2>
          <button type="button" onClick={onClose} disabled={recording} aria-label="Close camera" className="rounded-lg px-3 py-2 text-sm disabled:opacity-50">Close</button>
        </div>
        <video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview" className="max-h-[60vh] w-full rounded-xl bg-black object-contain" />
        {features && <p className="mt-2 text-xs text-muted-foreground" role="status">
          {features.width && features.height ? `${features.width} × ${features.height}` : 'Resolution unavailable'}
          {features.frameRate ? ` · ${features.frameRate} fps` : ''}
          {features.facingMode ? ` · ${features.facingMode} camera` : ''}
        </p>}
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={switchCamera} disabled={busy || recording} aria-label={`Switch to ${facingMode === 'user' ? 'rear' : 'front'} camera`} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm disabled:opacity-50">
            <FlipHorizontal className="h-4 w-4" /> Switch camera
          </button>
          {features?.torch && <button type="button" onClick={toggleTorch} disabled={recording} aria-pressed={Boolean(features.torchEnabled)} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
            <Flashlight className="h-4 w-4" /> {features.torchEnabled ? 'Flash off' : 'Flash on'}
          </button>}
          {features?.continuousFocus && <button type="button" onClick={setContinuousFocus} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
            <Focus className="h-4 w-4" /> Auto focus
          </button>}
          {features?.focusModes?.includes('manual') && features.focusDistanceRange && (
            <label className="flex min-w-48 items-center gap-2 text-xs">
              <span>Focus</span>
              <input
                type="range"
                min={features.focusDistanceRange.min}
                max={features.focusDistanceRange.max}
                step={features.focusDistanceRange.step || 0.1}
                value={features.focusDistance}
                onChange={setManualFocus}
                aria-label="Manual camera focus"
              />
            </label>
          )}
          <button type="button" onClick={capturePhoto} disabled={busy || recording} className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
            <Camera className="h-4 w-4" /> Take photo
          </button>
          {allowVideo && (recording
            ? <button type="button" onClick={finishRecording} className="inline-flex items-center gap-2 rounded-xl bg-destructive px-4 py-2 text-sm text-destructive-foreground"><CircleStop className="h-4 w-4" /> Stop recording</button>
            : <button type="button" onClick={startRecording} disabled={busy || !features} className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm disabled:opacity-50"><Video className="h-4 w-4" /> Record video</button>)}
        </div>
        {busy && <p role="status" className="mt-3 text-center text-sm text-muted-foreground">Preparing camera…</p>}
        {allowVideo && <p className="mt-2 text-center text-xs text-muted-foreground">Videos are limited to 45 seconds.</p>}
      </div>
    </div>
  )
}
