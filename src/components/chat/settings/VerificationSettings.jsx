import { useEffect, useRef, useState } from 'react'
import { Camera, IdCard, LoaderCircle, ShieldCheck } from 'lucide-react'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/authContextState'
import { appwriteData, isAppwriteAuthEnabled } from '../../../lib/appwrite'
import { analyzeBlob, detectFace, qualityHint, runLivenessCheck } from '../../../lib/faceDetection'
import VerificationBadge from '../VerificationBadge'

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model'
const DOCUMENT_TYPES = [
  { value: 'passport', label: 'Passport' },
  { value: 'national_id', label: 'National ID card' },
  { value: 'drivers_licence', label: 'Driving licence' },
]
const ACCEPTED_IMAGE_TYPES = 'image/jpeg,image/png,image/webp'

let faceApiPromise
async function loadFaceApi() {
  if (!faceApiPromise) {
    faceApiPromise = (async () => {
      const faceapi = await import('@vladmandic/face-api')
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ])
      return faceapi
    })()
  }
  return faceApiPromise
}

const EMPTY_FORM = {
  fullLegalName: '',
  dateOfBirth: '',
  documentType: 'passport',
  documentNumber: '',
  issuingCountry: '',
}

export default function VerificationSettings() {
  const { user } = useAuth()
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [record, setRecord] = useState(null)
  const [selfie, setSelfie] = useState(null)
  const [selfiePreview, setSelfiePreview] = useState('')
  const [selfieHint, setSelfieHint] = useState('')
  const [livenessStatus, setLivenessStatus] = useState('')
  const [idDoc, setIdDoc] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const loadRecord = async () => {
    try {
      if (isAppwriteAuthEnabled()) {
        const { record: result } = await appwriteData('verification.get')
        setRecord(result)
      } else {
        const { data, error: queryError } = await supabase.from('identity_verifications')
          .select('status, tier, match_score, reviewer_note, full_legal_name, date_of_birth, document_type, document_number, issuing_country, created_at')
          .eq('user_id', user.id).maybeSingle()
        if (queryError) throw queryError
        setRecord(data)
      }
    } catch (loadError) {
      setError(loadError.message || 'Could not load verification status.')
    }
  }

  useEffect(() => {
    if ((!supabase && !isAppwriteAuthEnabled()) || !user?.id) return undefined
    loadRecord()
    const timer = setInterval(loadRecord, 10000)
    return () => { clearInterval(timer); streamRef.current?.getTracks().forEach((t) => t.stop()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  useEffect(() => {
    if (!selfie) { setSelfiePreview(''); return undefined }
    const url = URL.createObjectURL(selfie)
    setSelfiePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [selfie])

  // Quality pre-check: surface predictable problems (dark, flat, blurred) as
  // advice the moment the selfie is captured, before detection is even run.
  useEffect(() => {
    if (!selfie) { setSelfieHint(''); return undefined }
    let cancelled = false
    analyzeBlob(selfie)
      .then((stats) => { if (!cancelled) setSelfieHint(qualityHint(stats) || '') })
      .catch(() => { if (!cancelled) setSelfieHint('') })
    return () => { cancelled = true }
  }, [selfie])

  const startCamera = async () => {
    setError('')
    try {
      // Ask for a definition high enough for the detector; the constrained
      // default (often 640x480) leaves too few pixels on the face.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      streamRef.current = stream
      videoRef.current.srcObject = stream
      await videoRef.current.play()
    } catch {
      stopCamera()
      setError('Camera access was blocked. Allow camera access and try again.')
    }
  }

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  const capture = async () => {
    const v = videoRef.current
    if (!v?.videoWidth) return
    setBusy('Running live face check…')
    setError('')
    try {
      const faceapi = await loadFaceApi()
      const liveness = await runLivenessCheck(faceapi, v)
      if (!liveness.passed) {
        setLivenessStatus('')
        setError(liveness.reason)
        return
      }
      setLivenessStatus(liveness.blinked ? 'Blink check passed.' : 'Live movement check passed.')
      const canvas = document.createElement('canvas')
      canvas.width = v.videoWidth
      canvas.height = v.videoHeight
      canvas.getContext('2d').drawImage(v, 0, 0)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
      if (!blob) throw new Error('The selfie photo could not be captured. Try again.')
      setSelfie(blob)
      stopCamera()
    } catch {
      setError('The live face check could not complete. Hold the camera steady and try again.')
    } finally {
      setBusy('')
    }
  }

  const uploadIdentityFile = async (blob, fileName, mimeType) => {
    if (isAppwriteAuthEnabled()) {
      if (!supabase) throw new Error('Secure identity uploads are not configured.')
      const { path, token } = await appwriteData('verification.upload.prepare', {
        fileName, mimeType, sizeBytes: blob.size,
      })
      const { error: uploadError } = await supabase.storage.from('identity-docs')
        .uploadToSignedUrl(path, token, blob, { contentType: mimeType })
      if (uploadError) throw uploadError
      return path
    }
    const path = `${user.id}/${fileName}`
    const { error: uploadError } = await supabase.storage.from('identity-docs').upload(path, blob, { contentType: mimeType })
    if (uploadError) throw uploadError
    return path
  }

  // Tier 2 — Manual: structured form + government ID + selfie, held for admin review.
  const submitManual = async () => {
    if (!selfie || !idDoc || busy) return
    if (!form.fullLegalName.trim() || !form.dateOfBirth || !form.documentNumber.trim() || !form.issuingCountry.trim()) {
      setError('Complete every field, attach your government ID and take a selfie.')
      return
    }
    setError(''); setInfo('')
    try {
      setBusy('Checking your photos…')
      const faceapi = await loadFaceApi()
      const [selfieProbe, idProbe] = await Promise.all([
        detectFace(faceapi, selfie),
        detectFace(faceapi, idDoc),
      ])
      if (!selfieProbe.found) throw new Error(selfieProbe.hint || 'No face found in your selfie. Try again in a good light.')
      const distance = idProbe.found
        ? faceapi.euclideanDistance(selfieProbe.descriptor, idProbe.descriptor)
        : null
      const score = distance == null ? null : Math.max(0, Math.min(1, 1 - distance))

      setBusy('Uploading securely…')
      const stamp = Date.now()
      const idExt = (idDoc.name?.split('.').pop() || 'jpg').toLowerCase()
      const selfiePath = await uploadIdentityFile(selfie, `selfie-${stamp}.jpg`, 'image/jpeg')
      const idPath = await uploadIdentityFile(idDoc, `id-${stamp}.${idExt}`, idDoc.type || 'image/jpeg')

      const details = {
        tier: 'manual',
        matchScore: score == null ? null : Number(score.toFixed(3)),
        fullLegalName: form.fullLegalName.trim(),
        dateOfBirth: form.dateOfBirth,
        documentType: form.documentType,
        documentNumber: form.documentNumber.trim(),
        issuingCountry: form.issuingCountry.trim(),
      }

      if (isAppwriteAuthEnabled()) {
        const { record: result } = await appwriteData('verification.submit', { ...details, selfiePath, idPath })
        setRecord(result)
      } else {
        const { error: insError } = await supabase.from('identity_verifications').upsert({
          user_id: user.id, status: 'pending', tier: 'manual',
          match_score: details.matchScore,
          selfie_path: selfiePath, id_document_path: idPath,
          full_legal_name: details.fullLegalName,
          date_of_birth: details.dateOfBirth,
          document_type: details.documentType,
          document_number: details.documentNumber,
          issuing_country: details.issuingCountry,
          reviewer_note: null, reviewed_by: null, reviewed_at: null,
        }, { onConflict: 'user_id' })
        if (insError) throw insError
        setRecord({ status: 'pending', tier: 'manual', match_score: details.matchScore })
      }
      setSelfie(null)
      setIdDoc(null)
      setForm(EMPTY_FORM)
      setInfo('Your documents were submitted for admin review.')
    } catch (err) {
      setError(err.message || 'Verification could not be submitted.')
    } finally {
      setBusy('')
    }
  }

  const status = record?.status
  const canSubmit = !status || status === 'rejected'
  const tierLabel = record?.tier === 'instant' ? 'instant' : 'manual review'

  const SelfieCard = (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <p className="flex items-center gap-2 font-semibold text-foreground"><Camera className="w-4 h-4" /> Take a clear selfie</p>
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
        <li>Face a lamp or window so your face is lit from the front, not behind you.</li>
        <li>Fill most of the frame with your face and look straight at the camera.</li>
        <li>Remove sunglasses, masks and hats, and hold the device steady.</li>
      </ul>
      {selfie ? (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            {selfiePreview && <img src={selfiePreview} alt="Your selfie" className="h-24 rounded-xl" />}
            <button onClick={() => { setSelfie(null); startCamera() }} className="text-sm text-primary hover:underline">Retake</button>
          </div>
          {selfieHint && <p className="text-xs text-amber-500">{selfieHint}</p>}
        </div>
      ) : (
        <>
          <video ref={videoRef} playsInline muted className="w-full max-w-sm rounded-xl bg-muted" />
          <div className="flex gap-2">
            <button type="button" onClick={startCamera} disabled={!!busy} className="rounded-full border border-border px-4 py-2 text-sm disabled:opacity-50">Start camera</button>
            <button type="button" onClick={capture} disabled={!!busy} className="rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
              {busy ? 'Checking live face…' : 'Blink or move, then capture'}
            </button>
          </div>
          {livenessStatus && <p role="status" className="text-xs text-primary">{livenessStatus}</p>}
        </>
      )}
    </div>
  )

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/30 p-4">
        <VerificationBadge userId={user?.id} className="w-6 h-6" />
        <div>
          {status && (
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {status === 'approved' ? 'Verified' : status === 'pending' ? 'Pending Verification' : 'Not verified'}
            </p>
          )}
          <p className="text-sm text-foreground">
            {status === 'approved'
              ? `Your identity is verified via ${tierLabel}. The blue verified check is shown on your profile.`
              : status === 'pending'
                ? 'Your documents were received and are waiting for admin review. The blue verified check appears once an admin approves them; this page updates automatically.'
                : status === 'rejected'
                  ? `Your documents were not accepted${record.reviewer_note ? ` — reason: ${record.reviewer_note}` : ''}. Please submit again.`
                  : 'Verify your identity to earn the blue verified check. Government ID submissions are reviewed by an admin.'}
          </p>
        </div>
      </div>

      {canSubmit && (
        <>
          <div>
            <button
              type="button"
              className="flex w-full flex-col items-start gap-1 rounded-2xl border border-primary bg-primary/10 p-3 text-left"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground"><ShieldCheck className="w-4 h-4 text-primary" /> Manual</span>
              <span className="text-xs text-muted-foreground">Government ID + selfie. Reviewed by an admin.</span>
            </button>
          </div>

          {SelfieCard}

          <div>
            <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
              <p className="font-semibold text-foreground">Identity details</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-muted-foreground">Full legal name</span>
                  <input value={form.fullLegalName} onChange={(e) => setForm({ ...form, fullLegalName: e.target.value })}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm" placeholder="As shown on your ID" />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-muted-foreground">Date of birth</span>
                  <input type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm" />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-muted-foreground">Document type</span>
                  <select value={form.documentType} onChange={(e) => setForm({ ...form, documentType: e.target.value })}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm">
                    {DOCUMENT_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-muted-foreground">Document number</span>
                  <input value={form.documentNumber} onChange={(e) => setForm({ ...form, documentNumber: e.target.value })}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm" />
                </label>
                <label className="text-sm sm:col-span-2">
                  <span className="mb-1 block text-muted-foreground">Issuing country</span>
                  <input value={form.issuingCountry} onChange={(e) => setForm({ ...form, issuingCountry: e.target.value })}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm" placeholder="e.g. United Kingdom" />
                </label>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
            <p className="flex items-center gap-2 font-semibold text-foreground"><IdCard className="w-4 h-4" /> Upload your government ID</p>
            <input type="file" accept={ACCEPTED_IMAGE_TYPES} onChange={(e) => setIdDoc(e.target.files?.[0] || null)} className="text-sm" />
            <p className="text-xs text-muted-foreground">A clear photo of the photo page of your passport, national ID or driving licence.</p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {info && <p className="text-sm text-primary">{info}</p>}

          <button onClick={submitManual} disabled={!selfie || !idDoc || !!busy}
            className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50">
            {busy ? <><LoaderCircle className="w-4 h-4 animate-spin" /> {busy}</> : 'Submit for admin review'}
          </button>
          <p className="text-xs text-muted-foreground">
            Face matching runs on your device. Your photos are stored privately and only reviewers (for manual submissions) can see them.
          </p>
        </>
      )}
    </div>
  )
}
