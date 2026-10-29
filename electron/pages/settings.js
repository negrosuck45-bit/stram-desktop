'use strict'

const form = document.getElementById('form')
const input = document.getElementById('url')
const hint = document.getElementById('hint')
const saveButton = document.getElementById('save')
const versionLabel = document.getElementById('version')

let busy = false

function setHint(message, isError = false) {
  hint.textContent = message
  hint.classList.toggle('error', isError)
}

async function load() {
  const [info, settings] = await Promise.all([
    window.stramDesktop.getInfo(),
    window.stramDesktop.getSettings(),
  ])
  input.value = settings.siteUrl
  versionLabel.textContent = `Stram Desktop v${info.appVersion}`
  input.focus()
  input.select()
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (busy) return

  busy = true
  saveButton.disabled = true
  saveButton.textContent = 'Saving…'
  setHint('Checking the address…')

  const result = await window.stramDesktop.saveSettings(input.value)

  if (!result || !result.ok) {
    busy = false
    saveButton.disabled = false
    saveButton.textContent = 'Save and reload'
    setHint((result && result.error) || 'That address did not work.', true)
    input.focus()
    return
  }

  setHint('Saved. Reloading…')
})

document.getElementById('reset').addEventListener('click', async () => {
  const result = await window.stramDesktop.resetSettings()
  input.value = (result && result.siteUrl) || 'https://stram.lol'
  setHint('Reset to the default address. Press Save and reload.')
})

document.getElementById('downloads').addEventListener('click', () => {
  window.stramDesktop.openDownloads()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.stramDesktop.closeSettings()
})

load().catch(() => setHint('Could not load settings.', true))
