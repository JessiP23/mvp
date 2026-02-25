const SWITCH_WINDOW_MS = 45_000
const MAX_EVENTS = 300

const session = {
  taskName: '',
  status: 'idle', // idle | active | stall | restart
  stallType: '',
  stallAt: null,
  restartLatencySec: null,
  lastTypingAt: null,
  tabSwitches: [],
  events: [],
}

const PROMPTS = {
  'tab-loop': 'One sentence now.',
  'dwell-freeze': 'Write ugly first draft.',
  'scroll-loop': 'Stop reading. Add one line.',
}

function now() {
  return Date.now()
}

function logEvent(type, meta = {}) {
  session.events.push({
    type,
    ts: new Date().toISOString(),
    taskName: session.taskName || null,
    status: session.status,
    ...meta,
  })
  if (session.events.length > MAX_EVENTS) {
    session.events.shift()
  }
}

function getSwitchCount() {
  const cutoff = now() - SWITCH_WINDOW_MS
  session.tabSwitches = session.tabSwitches.filter((t) => t >= cutoff)
  return session.tabSwitches.length
}

function setStatus(next) {
  session.status = next
}

function triggerStall(stallType) {
  if (!session.taskName || session.status === 'stall') return

  session.stallType = stallType
  session.stallAt = now()
  setStatus('stall')

  logEvent('stall_detected', {
    stall_type: stallType,
    prompt_variant: PROMPTS[stallType] || 'Continue.',
    intervention_timestamp: new Date().toISOString(),
  })

  broadcastState()
}

function handleRestart() {
  if (!session.stallAt) return

  session.restartLatencySec = Math.max(1, Math.round((now() - session.stallAt) / 1000))
  const resumed = now() - session.stallAt <= 30_000
  const prevType = session.stallType

  session.stallAt = null
  session.stallType = ''
  setStatus('restart')

  logEvent('task_restarted', {
    stall_type: prevType,
    resumed,
    restart_latency_sec: session.restartLatencySec,
  })

  broadcastState()

  setTimeout(() => {
    if (session.status === 'restart') {
      setStatus('active')
      broadcastState()
    }
  }, 2500)
}

function evaluateFromSignals({ idleForMs, scrollDistance, tabSwitchCount }) {
  if (!session.taskName) return

  // if stalled and typing resumes, handled via typing signal path
  if (session.status === 'stall') return

  if (tabSwitchCount > 3) {
    triggerStall('tab-loop')
    return
  }

  if (idleForMs > 15_000) {
    triggerStall('dwell-freeze')
    return
  }

  if (scrollDistance > 2000 && idleForMs > 5000) {
    triggerStall('scroll-loop')
  }
}

async function broadcastState() {
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    if (!tab.id) continue
    chrome.tabs.sendMessage(tab.id, { type: 'JARVIS_SYNC_STATE', payload: session }).catch(() => {})
  }
}

chrome.tabs.onActivated.addListener(() => {
  session.tabSwitches.push(now())
  logEvent('tab_activated', { switch_count_45s: getSwitchCount() })
  broadcastState()
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return

  if (msg.type === 'JARVIS_START_TASK') {
    session.taskName = (msg.payload?.taskName || '').trim()
    session.stallType = ''
    session.stallAt = null
    session.restartLatencySec = null
    session.lastTypingAt = now()
    session.tabSwitches = []
    setStatus('active')
    logEvent('task_started')
    broadcastState()
    sendResponse({ ok: true, session })
    return true
  }

  if (msg.type === 'JARVIS_SIGNAL_ACTIVITY') {
    const { typing = false, scrollDistance = 0 } = msg.payload || {}

    if (!session.taskName) {
      sendResponse({ ok: true, session })
      return true
    }

    if (typing) {
      session.lastTypingAt = now()
      if (session.status === 'stall') {
        handleRestart()
      } else if (session.status !== 'active') {
        setStatus('active')
        broadcastState()
      }
      sendResponse({ ok: true, session })
      return true
    }

    const idleForMs = session.lastTypingAt ? now() - session.lastTypingAt : Infinity
    evaluateFromSignals({
      idleForMs,
      scrollDistance,
      tabSwitchCount: getSwitchCount(),
    })

    sendResponse({ ok: true, session })
    return true
  }

  if (msg.type === 'JARVIS_CONTINUE') {
    session.lastTypingAt = now()
    if (session.status === 'stall') {
      handleRestart()
    } else {
      setStatus('active')
      broadcastState()
    }
    sendResponse({ ok: true, session })
    return true
  }

  if (msg.type === 'JARVIS_GET_STATE') {
    sendResponse({ ok: true, session, prompts: PROMPTS })
    return true
  }
})