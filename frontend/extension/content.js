const JARVIS_ROOT_ID = 'jarvis-mvp-root'

let ui = null
let local = { scrollDistance: 0, lastScrollY: window.scrollY }
let session = {
  taskName: '',
  status: 'idle',
  stallType: '',
  restartLatencySec: null,
}

const PROMPTS = {
  'tab-loop': 'One sentence now.',
  'dwell-freeze': 'Write ugly first draft.',
  'scroll-loop': 'Stop reading. Add one line.',
}

function isEditableTarget(target) {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = target.tagName?.toLowerCase()
  return tag === 'textarea' || tag === 'input'
}

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => resolve(res))
  })
}

let lastRenderKey = ''

function setSession(next) {
  const prev = session
  session = { ...session, ...next }

  if (prev.status !== session.status && (session.status === 'stall' || session.status === 'restart')) {
    local.scrollDistance = 0
  }

  const prevKey = `${prev.status}|${prev.taskName}|${prev.stallType}|${prev.restartLatencySec}`
  const nextKey = `${session.status}|${session.taskName}|${session.stallType}|${session.restartLatencySec}`
  if (prevKey === nextKey) return
  render()
}

function buildUI() {
  const root = document.createElement('div')
  root.id = JARVIS_ROOT_ID
  root.innerHTML = `
    <div class="jarvis-bubble jarvis-idle" role="region" aria-label="Jarvis activation assistant">
      <div class="jarvis-led"></div>
      <div class="jarvis-main">
        <p class="jarvis-state-label">idle presence</p>
        <div class="jarvis-body"></div>
      </div>
    </div>
  `
  document.documentElement.appendChild(root)
  ui = {
    root,
    bubble: root.querySelector('.jarvis-bubble'),
    body: root.querySelector('.jarvis-body'),
  }

  root.addEventListener('click', async (event) => {
    const el = event.target instanceof HTMLElement ? event.target.closest('[data-action]') : null
    if (!el) return
    const action = el.dataset.action
    if (!action) return

    if (action === 'start-task') {
      const input = root.querySelector('input[data-role="task-input"]')
      const taskName = input?.value?.trim()
      if (!taskName) return
      const res = await send('JARVIS_START_TASK', { taskName })
      if (res?.ok) setSession(res.session)
      return
    }

    if (action === 'continue' || action === 'dismiss-stall') {
      const res = await send('JARVIS_CONTINUE')
      if (res?.ok) setSession(res.session)
    }
  })
}

function renderBody() {
  switch (session.status) {
    case 'idle':
      return `
        <p class="jarvis-copy">What are you starting right now?</p>
        <div class="jarvis-row">
          <input data-role="task-input" type="text" placeholder="Q4 report" />
          <button data-action="start-task">Start</button>
        </div>
      `
    case 'active':
      return `<p class="jarvis-copy">Continue sentence. I'm here.</p>`
    case 'stall':
      return `
        <p class="jarvis-copy">Still working on <strong>${session.taskName || 'this task'}</strong>?</p>
        <div class="jarvis-micro">Detected: ${session.stallType}</div>
        <div class="jarvis-micro"><strong>${PROMPTS[session.stallType] || 'Continue.'}</strong></div>
        <div class="jarvis-row">
          <button data-action="dismiss-stall" class="jarvis-ghost">Yes</button>
          <button data-action="continue">Continue sentence</button>
        </div>
      `
    case 'restart':
      return `<p class="jarvis-copy">Nice. You restarted in <strong>${session.restartLatencySec || '-'}s</strong>.</p>`
    default:
      return ''
  }
}

function render() {
  if (!ui) return

  const renderKey = `${session.status}|${session.taskName}|${session.stallType}|${session.restartLatencySec}`
  if (renderKey === lastRenderKey) return
  lastRenderKey = renderKey

  ui.bubble.className = `jarvis-bubble jarvis-${session.status}`

  // Only replace body HTML when state actually changes
  ui.body.innerHTML = renderBody()

  const label = ui.root.querySelector('.jarvis-state-label')
  if (label) label.textContent = session.status

  // Autofocus only once when entering idle
  if (session.status === 'idle') {
    const input = ui.root.querySelector('input[data-role="task-input"]')
    if (input && document.activeElement !== input) input.focus()
  }
}


function reportActivity({ typing = false }) {
  // Do not spam background while user is typing into Jarvis input
  const active = document.activeElement
  const typingInJarvis = active instanceof HTMLElement && ui?.root?.contains(active)
  if (typingInJarvis) return

  send('JARVIS_SIGNAL_ACTIVITY', {
    typing,
    scrollDistance: local.scrollDistance,
  }).then((res) => {
    if (res?.ok) setSession(res.session)
  })
}

let heartbeatId = null

function attachSignalListeners() {
  const markTyping = () => {
    local.scrollDistance = 0
    reportActivity({ typing: true })
  }

  document.addEventListener('input', (e) => {
    if (isEditableTarget(e.target)) markTyping()
  }, true)

  document.addEventListener('keydown', (e) => {
    const target = e.target
    const targetIsEditable = isEditableTarget(target)
    const typingInJarvis = target instanceof HTMLElement && ui?.root?.contains(target)

    if (typingInJarvis || targetIsEditable) return
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) return
    markTyping()
  }, true)

  window.addEventListener('scroll', () => {
    const delta = Math.abs(window.scrollY - local.lastScrollY)
    local.lastScrollY = window.scrollY
    local.scrollDistance += delta
    reportActivity({ typing: false })
  }, { passive: true })

  // NEW: heartbeat so dwell-freeze can trigger even when user is fully idle
  heartbeatId = window.setInterval(() => {
    reportActivity({ typing: false })
  }, 2000)

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'JARVIS_SYNC_STATE') setSession(message.payload || {})
  })

  window.addEventListener('beforeunload', () => {
    if (heartbeatId) clearInterval(heartbeatId)
  })
}

async function init() {
  if (document.getElementById(JARVIS_ROOT_ID)) return
  buildUI()
  attachSignalListeners()
  const res = await send('JARVIS_GET_STATE')
  if (res?.ok) setSession(res.session)
  render()
}

init()