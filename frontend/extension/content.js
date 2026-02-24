const JARVIS_ROOT_ID = 'jarvis-mvp-root'

const RULES = {
  tabSwitchThreshold: 3,
  typingIdleMs: 15_000,
  scrollWithoutTypingPx: 2_000,
}

const state = {
  taskName: '',
  status: 'idle',
  lastTypingAt: null,
  stallAt: null,
  restartLatencySec: null,
  scrollDistance: 0,
  tabSwitchCount: 0,
  stallReason: '',
}

let ui = null
let evaluationTimer = null

function now() {
  return Date.now()
}

function isEditableTarget(target) {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = target.tagName?.toLowerCase()
  return tag === 'textarea' || tag === 'input'
}

function emitEvent(type, meta = {}) {
  const payload = {
    type,
    timestamp: new Date().toISOString(),
    taskName: state.taskName || null,
    status: state.status,
    ...meta,
  }

  chrome.runtime.sendMessage({ type: 'JARVIS_LOG_EVENT', payload })
}

function setStatus(nextStatus) {
  state.status = nextStatus
  render()
}

function triggerStall(reason) {
  if (!state.taskName || state.status === 'stall') return
  state.stallAt = now()
  state.stallReason = reason
  setStatus('stall')
  emitEvent('stall_detected', { reason })
}

function handleRestart() {
  if (!state.stallAt) return
  state.restartLatencySec = Math.max(1, Math.round((now() - state.stallAt) / 1000))
  state.stallAt = null
  state.stallReason = ''
  setStatus('restart')
  emitEvent('task_restarted', { restartLatencySec: state.restartLatencySec })

  window.setTimeout(() => {
    if (state.status === 'restart') {
      setStatus('active')
    }
  }, 2500)
}

function evaluateStall() {
  if (!state.taskName || state.status === 'stall') return

  const idleForMs = state.lastTypingAt ? now() - state.lastTypingAt : Infinity

  if (state.tabSwitchCount > RULES.tabSwitchThreshold) {
    triggerStall('tab switch loop')
    return
  }

  if (idleForMs > RULES.typingIdleMs) {
    triggerStall('dwell without typing')
    return
  }

  if (state.scrollDistance > RULES.scrollWithoutTypingPx && idleForMs > 5_000) {
    triggerStall('scroll loop')
  }
}

function attachSignalListeners() {
  document.addEventListener('input', (event) => {
    if (!isEditableTarget(event.target)) return

    state.lastTypingAt = now()
    state.scrollDistance = 0

    if (state.status === 'stall') {
      handleRestart()
      return
    }

    if (state.taskName && state.status !== 'active') {
      setStatus('active')
    }
  })

  let lastScrollY = window.scrollY

  window.addEventListener(
    'scroll',
    () => {
      const delta = Math.abs(window.scrollY - lastScrollY)
      lastScrollY = window.scrollY
      state.scrollDistance += delta
    },
    { passive: true }
  )

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'JARVIS_TAB_ACTIVITY') return

    state.tabSwitchCount = message.payload.switchCount

    if (state.taskName && state.status !== 'stall') {
      evaluateStall()
    }
  })
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

  const bubble = root.querySelector('.jarvis-bubble')
  const body = root.querySelector('.jarvis-body')
  ui = { root, bubble, body }

  root.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return

    const action = target.dataset.action
    if (!action) return

    if (action === 'start-task') {
      const input = root.querySelector('input[data-role="task-input"]')
      const value = input?.value?.trim()
      if (!value) return

      state.taskName = value
      state.lastTypingAt = now()
      state.tabSwitchCount = 0
      state.scrollDistance = 0
      setStatus('active')
      emitEvent('task_started')
      return
    }

    if (action === 'continue') {
      state.lastTypingAt = now()
      state.scrollDistance = 0

      if (state.status === 'stall') {
        handleRestart()
      } else {
        setStatus('active')
      }
      return
    }

    if (action === 'dismiss-stall') {
      setStatus('active')
    }
  })
}

function renderBody() {
  if (!ui) return ''

  switch (state.status) {
    case 'idle':
      return `
        <p class="jarvis-copy">What are you starting right now?</p>
        <div class="jarvis-row">
          <input data-role="task-input" type="text" placeholder="Q4 report" />
          <button data-action="start-task">Start</button>
        </div>
      `

    case 'active':
      return `
        <p class="jarvis-copy">Continue sentence. I'm here.</p>
        <div class="jarvis-micro">Watching for stall signals locally.</div>
      `

    case 'stall':
      return `
        <p class="jarvis-copy">Still working on <strong>${state.taskName}</strong>?</p>
        <div class="jarvis-micro">Detected: ${state.stallReason}</div>
        <div class="jarvis-row">
          <button data-action="dismiss-stall" class="jarvis-ghost">Yes</button>
          <button data-action="continue">Continue sentence</button>
        </div>
      `

    case 'restart':
      return `
        <p class="jarvis-copy">Nice. You restarted in <strong>${state.restartLatencySec}s</strong>.</p>
        <div class="jarvis-micro">Activation latency event logged.</div>
      `

    default:
      return ''
  }
}

function render() {
  if (!ui) return

  ui.bubble.className = `jarvis-bubble jarvis-${state.status}`
  ui.body.innerHTML = renderBody()
  const label = ui.root.querySelector('.jarvis-state-label')

  if (label) {
    const copy = {
      idle: 'idle presence',
      active: 'active typing',
      stall: 'stall detected',
      restart: 'restart reinforcement',
    }

    label.textContent = copy[state.status]
  }
}

function init() {
  if (document.getElementById(JARVIS_ROOT_ID)) return

  buildUI()
  render()
  attachSignalListeners()

  evaluationTimer = window.setInterval(evaluateStall, 1000)
  emitEvent('jarvis_loaded')
}

init()
