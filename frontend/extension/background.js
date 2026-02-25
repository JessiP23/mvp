const SWITCH_WINDOW_MS = 45_000
const MAX_EVENTS = 300
const STALL_COOLDOWN_MS = 12_000

const session = {
  taskName: '',
  status: 'idle',
  stallType: '',
  stallAt: null,
  restartLatencySec: null,
  lastTypingAt: null,
  tabSwitches: [],
  events: [],
  currentPrompt: null,
  lastInterventionAt: null,
  lastInterventionAccepted: null,
  tone: 'gentle', // gentle | firm
  cooldownUntil: 0,
}

const PROMPTS_BY_STALL = {
  gentle: {
    'tab-loop': ['One sentence now.', 'Return to the doc. Write one line.'],
    'dwell-freeze': ['Write ugly first draft.', 'Bad first line is perfect. Type it now.'],
    'scroll-loop': ['Stop reading. Add one line.', 'Summarize what you read in one sentence.'],
  },
  firm: {
    'tab-loop': ['Back to task. One line now.', 'No switching. Write one sentence.'],
    'dwell-freeze': ['Start now. Imperfect is required.', 'Type the first line immediately.'],
    'scroll-loop': ['Stop scrolling. Produce one line.', 'Reading pause. Output one sentence now.'],
  },
}

function now() { return Date.now() }

function logEvent(type, meta = {}) {
  session.events.push({
    type,
    ts: new Date().toISOString(),
    taskName: session.taskName || null,
    status: session.status,
    ...meta,
  })
  if (session.events.length > MAX_EVENTS) session.events.shift()
}

function getSwitchCount() {
  const cutoff = now() - SWITCH_WINDOW_MS
  session.tabSwitches = session.tabSwitches.filter((t) => t >= cutoff)
  return session.tabSwitches.length
}

function setStatus(next) { session.status = next }

function pickPrompt(stallType) {
  const bank = PROMPTS_BY_STALL[session.tone] || PROMPTS_BY_STALL.gentle
  const list = bank[stallType] || ['Continue.']
  return list[Math.floor(Math.random() * list.length)]
}

function inCooldown() {
  return now() < (session.cooldownUntil || 0)
}

function triggerStall(stallType) {
  if (!session.taskName || session.status === 'stall') return
  if (inCooldown()) return
  session.stallType = stallType
  session.stallAt = now()
  session.currentPrompt = pickPrompt(stallType)
  session.lastInterventionAt = new Date().toISOString()
  session.lastInterventionAccepted = null
  setStatus('stall')

  logEvent('stall_detected', {
    stall_type: stallType,
    prompt_variant: session.currentPrompt,
    intervention_timestamp: session.lastInterventionAt,
    tone: session.tone,
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
  session.cooldownUntil = now() + STALL_COOLDOWN_MS
  session.tabSwitches = []
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
  if (!session.taskName || session.status === 'stall') return
  if (inCooldown()) return
  if (tabSwitchCount >= 2) return triggerStall('tab-loop')
  if (scrollDistance > 700 && idleForMs > 3000) return triggerStall('scroll-loop')
  if (idleForMs > 15000) return triggerStall('dwell-freeze')
}

function buildMetrics() {
  const stalls = session.events.filter((e) => e.type === 'stall_detected')
  const restarts = session.events.filter((e) => e.type === 'task_restarted')
  const responses = session.events.filter((e) => e.type === 'intervention_response')

  const latencies = restarts.map((r) => Number(r.restart_latency_sec)).filter((n) => Number.isFinite(n))
  const medianRestartLatencySec = latencies.length
    ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)]
    : null

  const accepted = responses.filter((r) => r.accepted === true).length
  const acceptanceRate = responses.length ? accepted / responses.length : null

  const byType = { 'tab-loop': 0, 'dwell-freeze': 0, 'scroll-loop': 0 }
  for (const s of stalls) byType[s.stall_type] = (byType[s.stall_type] || 0) + 1

  return {
    medianRestartLatencySec,
    acceptanceRate,
    stallCounts: byType,
    totalStalls: stalls.length,
    totalRestarts: restarts.length,
    timeline: session.events.slice(-10).reverse(),
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

setInterval(() => {
  if (session.status !== 'stall' || !session.stallAt) return
  const elapsed = now() - session.stallAt
  if (elapsed > 30_000 && session.lastInterventionAccepted == null) {
    session.lastInterventionAccepted = false
    logEvent('intervention_response', {
      stall_type: session.stallType,
      accepted: false,
      ts_response: new Date().toISOString(),
    })
  }
}, 5000)

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
    if (!session.taskName) return sendResponse({ ok: true, session }), true

    if (typing) {
      session.lastTypingAt = now()
      if (session.status === 'stall') handleRestart()
      else if (session.status !== 'active') { setStatus('active'); broadcastState() }
      sendResponse({ ok: true, session })
      return true
    }

    const idleForMs = session.lastTypingAt ? now() - session.lastTypingAt : Infinity
    evaluateFromSignals({ idleForMs, scrollDistance, tabSwitchCount: getSwitchCount() })
    sendResponse({ ok: true, session })
    return true
  }

  if (msg.type === 'JARVIS_CONTINUE') {
    session.lastTypingAt = now()
    session.lastInterventionAccepted = true
    session.tabSwitches = []
    session.cooldownUntil = now() + STALL_COOLDOWN_MS
    logEvent('intervention_response', {
      stall_type: session.stallType || null,
      accepted: true,
      ts_response: new Date().toISOString(),
    })

    if (session.status === 'stall') handleRestart()
    else { setStatus('active'); broadcastState() }

    sendResponse({ ok: true, session })
    return true
  }

  if (msg.type === 'JARVIS_SET_TONE') {
    const tone = msg.payload?.tone === 'firm' ? 'firm' : 'gentle'
    session.tone = tone
    logEvent('tone_changed', { tone })
    sendResponse({ ok: true, tone })
    return true
  }

  if (msg.type === 'JARVIS_GET_STATE') {
    sendResponse({ ok: true, session })
    return true
  }

  if (msg.type === 'JARVIS_GET_METRICS') {
    sendResponse({ ok: true, metrics: buildMetrics(), tone: session.tone })
    return true
  }

  if (msg.type === 'JARVIS_EXPORT_EVENTS') {
    sendResponse({ ok: true, events: session.events })
    return true
  }
})