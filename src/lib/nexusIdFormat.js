// Live formatting for Nexus chat IDs.
//
// A Nexus chat ID is ten digits whose canonical display form groups them as
// 10-XXXX-XXXX (for example 10-1234-5678). The digits-only form (1012345678)
// is what the backend validates after stripping separators (`/^10\d{8}$/`).
// These helpers normalize whatever the user types or pastes into the display
// form and report the caret offset that keeps the cursor next to the digit the
// user was editing, so live formatting never disturbs typing.

export const NEXUS_ID_DIGITS = 10
export const NEXUS_ID_PATTERN = /^10\d{8}$/

// Digits only, capped at the ten a Nexus ID holds.
export function nexusIdDigits(raw) {
  return String(raw ?? '').replace(/\D/g, '').slice(0, NEXUS_ID_DIGITS)
}

// Groups up to ten digits as 10-XXXX-XXXX, tolerating partial input:
// "1" -> "1", "10" -> "10", "10123" -> "10-123", "1012345678" -> "10-1234-5678".
export function groupNexusIdDigits(raw) {
  const digits = nexusIdDigits(raw)
  if (digits.length <= 2) return digits
  if (digits.length <= 6) return `${digits.slice(0, 2)}-${digits.slice(2)}`
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`
}

// True when the raw value forms a complete, valid Nexus ID (10\d{8}).
export function isCompleteNexusId(raw) {
  return NEXUS_ID_PATTERN.test(nexusIdDigits(raw))
}

// Index just past the `count`-th digit of an already formatted value.
function caretForDigitCount(value, count) {
  if (count <= 0) return 0
  let seen = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] >= '0' && value[index] <= '9') {
      seen += 1
      if (seen === count) return index + 1
    }
  }
  return value.length
}

// Formats a raw input value and returns the display value plus the caret offset
// to restore. `caret` is the selectionStart of the raw value; when it is
// missing the caret follows the end of the value. Non-numeric characters are
// dropped and separators are placed at the fixed 10-XXXX-XXXX positions, so a
// manually mistyped separator is corrected on the next keystroke.
export function applyNexusIdFormat(raw, caret) {
  const rawValue = String(raw ?? '')
  const caretAt = Number.isInteger(caret)
    ? Math.min(Math.max(caret, 0), rawValue.length)
    : rawValue.length
  const digitsBeforeCaret = rawValue.slice(0, caretAt).replace(/\D/g, '').length
  const digits = nexusIdDigits(rawValue)
  const value = groupNexusIdDigits(digits)
  return { value, caret: caretForDigitCount(value, Math.min(digitsBeforeCaret, digits.length)) }
}
