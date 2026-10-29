'use strict'

const button = document.getElementById('signin')
const status = document.getElementById('status')
let resetTimer = null

function resetButton(label) {
  button.disabled = false
  button.textContent = label || 'Sign in'
}

button.addEventListener('click', async () => {
  if (button.disabled) return

  button.disabled = true
  button.textContent = 'Opening browser…'
  status.textContent = 'Finish signing in in your browser. This window will update automatically.'

  try {
    const started = await window.stramDesktop.startSignIn()
    if (!started) {
      resetButton()
      status.textContent = 'Could not start sign-in. Try again.'
      return
    }
  } catch {
    resetButton()
    status.textContent = 'Could not start sign-in. Try again.'
    return
  }

  window.clearTimeout(resetTimer)
  resetTimer = window.setTimeout(() => {
    if (!button.disabled) return
    resetButton('Sign in again')
    status.textContent = 'Still waiting for the browser. You can start again if needed.'
  }, 8000)
})

for (const link of document.querySelectorAll('[data-url]')) {
  link.addEventListener('click', () => {
    const target = link.getAttribute('data-url')
    if (target) window.stramDesktop.openExternal(target)
  })
}
