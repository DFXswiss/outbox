const textField = document.querySelector('#text')
const checks = document.querySelector('#review-checks')
const previewText = document.querySelector('#preview-text')
const charCount = document.querySelector('#character-count')
const cost = document.querySelector('#cost-hint')
const submit = document.querySelector('#submit-button')
const unavailable = document.querySelector('#check-unavailable')
const imageField = document.querySelector('#image')
const imagePreview = document.querySelector('#image-preview')
const imageMessage = document.querySelector('#image-message')
const findingIcons = {
  blocked: document.querySelector('#icon-blocked'),
  hint: document.querySelector('#icon-hint'),
  clear: document.querySelector('#icon-clear')
}

let requestNumber = 0
let reviewController
let imageSelection = 0
let debounce
let objectUrl

function addLine(className, message) {
  const line = document.createElement('div')
  line.className = `finding ${className}`
  const icon = findingIcons[className].content.firstElementChild.cloneNode(true)
  const label = document.createElement('span')
  label.textContent = message
  line.append(icon, label)
  checks.append(line)
}

function renderFindings(blocking, hints) {
  checks.replaceChildren()
  if (textField.value.trim() === '') {
    const empty = document.createElement('p')
    empty.className = 'scope'
    empty.textContent = 'Checks appear here as you type.'
    checks.append(empty)
    submit.disabled = false
    submit.removeAttribute('aria-describedby')
    return
  }
  blocking.forEach((line) => addLine('blocked', line))
  hints.forEach((line) => addLine('hint', line))
  if (blocking.length === 0 && hints.length === 0) addLine('clear', 'No blocking findings and no hints.')
  submit.disabled = blocking.length > 0
  if (blocking.length > 0) submit.setAttribute('aria-describedby', 'review-checks')
  else submit.removeAttribute('aria-describedby')
}

async function checkText(sequence) {
  const text = textField.value
  const controller = new AbortController()
  reviewController = controller
  previewText.textContent = text || 'Preview'
  try {
    const response = await fetch('/api/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      credentials: 'same-origin',
      signal: controller.signal
    })
    const result = await response.json()
    if (sequence !== requestNumber) return
    if (!response.ok || result.ok !== true) throw new Error('Review failed')
    charCount.textContent = String(result.charCount)
    cost.textContent = result.costHint
    renderFindings(result.blocking, result.hints)
    unavailable.hidden = true
  } catch (error) {
    if (sequence !== requestNumber) return
    if (error && error.name === 'AbortError') return
    checks.replaceChildren()
    unavailable.hidden = false
    submit.disabled = false
    submit.removeAttribute('aria-describedby')
  } finally {
    if (reviewController === controller) reviewController = undefined
  }
}

textField.addEventListener('input', () => {
  window.clearTimeout(debounce)
  if (reviewController) reviewController.abort()
  reviewController = undefined
  const sequence = ++requestNumber
  debounce = window.setTimeout(() => void checkText(sequence), 400)
})

imageField.addEventListener('change', async () => {
  const selection = ++imageSelection
  const file = imageField.files && imageField.files[0]
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = undefined
  imagePreview.hidden = true
  imagePreview.removeAttribute('src')
  imageMessage.textContent = ''
  if (!file) return
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  if (selection !== imageSelection) return
  const png = header.length >= 8 && header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71 && header[4] === 13 && header[5] === 10 && header[6] === 26 && header[7] === 10
  const jpeg = header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
  if (file.size > 5 * 1024 * 1024) imageMessage.textContent = 'This image is larger than 5 MB.'
  else if (!png && !jpeg) imageMessage.textContent = 'Choose a PNG or JPEG image.'
  if (png || jpeg) {
    objectUrl = URL.createObjectURL(file)
    imagePreview.src = objectUrl
    imagePreview.hidden = false
  }
})

if (textField.value.trim() !== '') void checkText(++requestNumber)
