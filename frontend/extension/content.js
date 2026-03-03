const JARVIS_ROOT_ID = 'jarvis-mvp-root'

let ui = null
let collapsed = true

function getScrollTop() {
  return (
    window.scrollY ||
    document.documentElement.scrollTop ||
    document.body.scrollTop ||
    0
  )
}

let local = { scrollDistance: 0, lastScrollY: getScrollTop() }

let session = {
  taskName: '',
  status: 'idle',
  stallType: '',
  restartLatencySec: null,
  ifiScore: 0,
}

const PROMPTS = {
  'tab-loop': 'One sentence now.',
  'dwell-freeze': 'Write ugly first draft.',
  'scroll-loop': 'Stop reading. Add one line.',
  'drift-escalated': "What's one 30-second action? Even just opening the right tab.",
}

// ── Cursor entropy ────────────────────────────────────────────────────────────
// Tracks directional randomness of cursor movement.
// Purposeful work = directional. Stalling = circular drift.
const cursorPositions = []
const CURSOR_WINDOW = 20

function computeCursorEntropy() {
  if (cursorPositions.length < 8) return 0

  let totalDistance = 0
  for (let i = 1; i < cursorPositions.length; i++) {
    const dx = cursorPositions[i].x - cursorPositions[i - 1].x
    const dy = cursorPositions[i].y - cursorPositions[i - 1].y
    totalDistance += Math.sqrt(dx * dx + dy * dy)
  }

  const first = cursorPositions[0]
  const last  = cursorPositions[cursorPositions.length - 1]
  const netDx = last.x - first.x
  const netDy = last.y - first.y
  const net   = Math.sqrt(netDx * netDx + netDy * netDy)

  if (totalDistance < 15) return 0
  // 0 = straight line (purposeful), 1 = circular drift (avoidance)
  return Math.max(0, Math.min(1, 1 - net / totalDistance))
}

// ─────────────────────────────────────────────────────────────────────────────

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

  if (prev.status !== session.status && ['stall', 'restart', 'drift'].includes(session.status)) {
    local.scrollDistance = 0
  }

  const prevKey = `${prev.status}|${prev.taskName}|${prev.stallType}|${prev.restartLatencySec}`
  const nextKey = `${session.status}|${session.taskName}|${session.stallType}|${session.restartLatencySec}`
  if (prevKey !== nextKey) render()

  // Lightweight IFI bar update — no DOM rebuild needed
  updateIFIBar()
}

function buildUI() {
  const root = document.createElement('div')
  root.id = JARVIS_ROOT_ID
  root.dataset.collapsed = 'true'
  root.innerHTML = `
    <div class="jarvis-shell">
      <div>
        <button class="jarvis-pill" data-action="toggle" aria-label="Toggle Jarvis">
          <span class="jarvis-led"></span>
          <span>Jarvis</span>
        </button>
        <div class="jarvis-panel">
          <div class="jarvis-bubble jarvis-idle" role="region" aria-label="Jarvis activation assistant">
            <div class="jarvis-led"></div>
            <div class="jarvis-main">
              <p class="jarvis-state-label">idle presence</p>
              <div class="jarvis-body"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
  document.documentElement.appendChild(root)
  ui = {
    root,
    bubble: root.querySelector('.jarvis-bubble'),
    body:   root.querySelector('.jarvis-body'),
    label:  root.querySelector('.jarvis-state-label'),
    pillLed: root.querySelector('.jarvis-pill .jarvis-led'),
  }

  root.addEventListener('click', async (event) => {
    const el = event.target instanceof HTMLElement ? event.target.closest('[data-action]') : null
    if (!el) return
    const action = el.dataset.action

    if (action === 'toggle') {
      collapsed = !collapsed
      ui.root.dataset.collapsed = collapsed ? 'true' : 'false'
      return
    }

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
      return
    }

    // Drift: "I'm good" — self-corrected, reset IFI
    if (action === 'dismiss-drift') {
      const res = await send('JARVIS_DISMISS_DRIFT')
      if (res?.ok) setSession(res.session)
      return
    }

    // Drift: "Help me start" — escalate to stall with Layer 1 prompt
    if (action === 'help-focus') {
      const res = await send('JARVIS_ESCALATE_DRIFT')
      if (res?.ok) setSession(res.session)
      return
    }
  })
}

const STATE_LABELS = {
  idle:    'idle presence',
  active:  'active typing',
  drift:   'drift detected',
  stall:   'stall detected',
  restart: 'restart reinforcement',
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
      return `
        <p class="jarvis-copy">Continue sentence. I'm here.</p>
        <div class="jarvis-ifi-track" title="Initiation Friction Index — rises as avoidance signals accumulate">
          <div class="jarvis-ifi-fill"></div>
        </div>
        <span class="jarvis-ifi-label">IFI ${session.ifiScore || 0}</span>
      `
    case 'drift':
      return `
        <p class="jarvis-copy">Still on <strong>${session.taskName || 'this task'}</strong>?<br>I'm noticing some drift.</p>
        <div class="jarvis-micro">IFI ${session.ifiScore || 0} — pre-stall signal</div>
        <div class="jarvis-layer-block">
          <span class="jarvis-layer-badge">Layer 1 · Atomize task</span>
          <p class="jarvis-micro" style="margin-top:3px;font-size:11px;">What's one 30-second action right now?</p>
        </div>
        <div class="jarvis-row">
          <button data-action="dismiss-drift" class="jarvis-ghost">I'm good</button>
          <button data-action="help-focus">Help me start</button>
        </div>
      `
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

// Lightweight: updates IFI bar fill width + color without rebuilding DOM
function updateIFIBar() {
  const fill = ui?.root?.querySelector('.jarvis-ifi-fill')
  if (!fill) return
  const score = session.ifiScore || 0
  fill.style.width = `${score}%`
  if (score < 45) {
    fill.style.background = 'linear-gradient(90deg, #4d7bff, #83f4bc)'
  } else if (score < 65) {
    fill.style.background = 'linear-gradient(90deg, #4d7bff, #ffd166)'
  } else {
    fill.style.background = 'linear-gradient(90deg, #ff7a7a, #ffd166)'
  }
}

function render() {
  if (!ui) return
  const renderKey = `${session.status}|${session.taskName}|${session.stallType}|${session.restartLatencySec}`
  if (renderKey === lastRenderKey) return
  lastRenderKey = renderKey

  ui.bubble.className = `jarvis-bubble jarvis-${session.status}`
  ui.label.textContent = STATE_LABELS[session.status] || session.status
  ui.body.innerHTML = renderBody()

  // Pill LED color by state
  ui.pillLed.style.background =
    session.status === 'active'  ? '#83f4bc' :
    session.status === 'drift'   ? '#ffd166' :
    session.status === 'stall'   ? '#ff7a7a' :
    session.status === 'restart' ? '#ffd166' :
    '#6de1ff'

  updateIFIBar()
}

function reportActivity({ typing = false }) {
  const active = document.activeElement
  const typingInJarvis = active instanceof HTMLElement && ui?.root?.contains(active)
  if (typingInJarvis) return

  send('JARVIS_SIGNAL_ACTIVITY', {
    typing,
    scrollDistance: local.scrollDistance,
    cursorEntropy: computeCursorEntropy(),
  }).then((res) => {
    if (res?.ok) setSession(res.session)
  })
}

let heartbeatId = null

function attachSignalListeners() {
  const markTyping = () => {
    local.scrollDistance = 0
    cursorPositions.length = 0  // typing resets entropy
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
    const currentY = getScrollTop()
    const delta = Math.abs(currentY - local.lastScrollY)
    local.lastScrollY = currentY
    local.scrollDistance += delta
    reportActivity({ typing: false })
  }, { passive: true })

  window.addEventListener('wheel', (e) => {
    local.scrollDistance += Math.abs(e.deltaY || 0)
    reportActivity({ typing: false })
  }, { passive: true })

  // Cursor entropy: track last N positions for directional variance
  document.addEventListener('mousemove', (e) => {
    cursorPositions.push({ x: e.clientX, y: e.clientY })
    if (cursorPositions.length > CURSOR_WINDOW) cursorPositions.shift()
  }, { passive: true })

  // Heartbeat: triggers dwell-freeze detection even during full idle
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
