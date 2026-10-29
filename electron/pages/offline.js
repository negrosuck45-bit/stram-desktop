'use strict'

const params = new URLSearchParams(window.location.search)
const detail = document.getElementById('detail')
const siteLabel = document.getElementById('site')
const versionLabel = document.getElementById('version')

const code = params.get('code') || ''
const description = params.get('description') || 'The page could not be loaded.'
const url = params.get('url') || ''

detail.textContent = [description, code ? `Error ${code}` : '', url].filter(Boolean).join('\n')
siteLabel.textContent = url || 'stram.lol'

document.getElementById('retry').addEventListener('click', async () => {
  const button = document.getElementById('retry')
  button.disabled = true
  button.textContent = 'Trying…'
  await window.stramDesktop.retry()
})

document.getElementById('browser').addEventListener('click', () => {
  window.stramDesktop.openExternal(url || 'https://stram.lol')
})

document.getElementById('settings').addEventListener('click', () => {
  window.stramDesktop.openSettingsWindow()
})

window.stramDesktop.getInfo().then((info) => {
  versionLabel.textContent = `v${info.appVersion}`
  if (!url) siteLabel.textContent = info.siteUrl
})
