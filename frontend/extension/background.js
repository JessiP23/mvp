const SWITCH_WINDOW_MS = 45_000
const MAX_EVENTS = 300
const STALL_COOLDOWN_MS = 12_000
const DRIFT_IFI_THRESHOLD = 65  // pre-stall amber warning
const STALL_IFI_THRESHOLD = 90  // full stall via IFI alone

const session = {
  taskName: '',
  status: 'idle',  // idle | active | drift | stall | restart
  stallType: '',
  stallAt: null,
  restartLatencySec: null,
  lastTypingAt: null,
  tabSwitches: [],
  events: [],
  currentPrompt: null,
  lastInterventionAt: null,
  lastInterventionAccepted: null,
  tone: 'gentle',
  cooldownUntil: 0,
  ifiScore: 0,  // 0-100 composite Initiation Friction Index
}

const PROMPTS_BY_STALL = {
  gentle: {
    'tab-loop': ['One sentence now.', 'Return to the doc. Write one line.'],
    'dwell-freeze': ['Write ugly first draft.', 'Bad first line is perfect. Type it now.'],
    'scroll-loop': ['Stop reading. Add one line.', 'Summarize what you read in one sentence.'],
    'drift-escalated': ["What's one 30-second action? Even just opening the right tab.", 'Name one thing you can do in under a minute.'],
  },
  firm: {
    'tab-loop': ['Back to task. One line now.', 'No switching. Write one sentence.'],
    'dwell-freeze': ['Start now. Imperfect is required.', 'Type the first line immediately.'],
    'scroll-loop': ['Stop scrolling. Produce one line.', 'Reading pause. Output one sentence now.'],
    'drift-escalated': ['Drift detected. One action now.', "Stop reading. Write something—anything."],
  },
}

function now() { return Date.now() }

function logEvent(type, meta = {}) {
  session.events.push({
    type,
    ts: new Date().toISOString(),
    taskName: session.taskName || null,
    status: session.status,
    ifi_score: session.ifiScore,
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

// IFI: composite 0-100 score from all behavioral signals
// Weights: dwell 35%, scroll 25%, tab switches 25%, cursor entropy 15%
function computeIFI({ idleForMs, scrollDistance, tabSwitchCount, cursorEntropy = 0 }) {
  const dwell   = Math.min(1, idleForMs / 15000)
  const scroll  = Math.min(1, scrollDistance / 700)
  const tabs    = Math.min(1, tabSwitchCount / 2)
  const entropy = Math.max(0, Math.min(1, cursorEntropy))
  return Math.round((dwell * 0.35 + scroll * 0.25 + tabs * 0.25 + entropy * 0.15) * 100)
}

function triggerDrift() {
  if (!session.taskName) return
  if (session.status === 'stall' || session.status === 'drift') return
  if (inCooldown()) return

  setStatus('drift')
  logEvent('drift_detected', { ifi_score: session.ifiScore })
  broadcastState()
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
    ifi_score: session.ifiScore,
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
  session.ifiScore = 0
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

function evaluateFromSignals({ idleForMs, scrollDistance, tabSwitchCount, cursorEntropy = 0 }) {
  if (!session.taskName || session.status === 'stall') return
  if (inCooldown()) return

  // Compute composite IFI from all signals (including cursor entropy)
  const ifi = computeIFI({ idleForMs, scrollDistance, tabSwitchCount, cursorEntropy })
  session.ifiScore = ifi

  // Hard signal thresholds → full stall (existing rules, unchanged)
  if (tabSwitchCount >= 2) return triggerStall('tab-loop')
  if (scrollDistance > 700 && idleForMs > 3000) return triggerStall('scroll-loop')
  if (idleForMs > 15000) return triggerStall('dwell-freeze')

  // IFI composite threshold → drift (pre-stall warning, new)
  if (ifi >= DRIFT_IFI_THRESHOLD && session.status === 'active') {
    return triggerDrift()
  }

  // Self-correction: user corrected during drift (IFI fell back below 40)
  if (session.status === 'drift' && ifi < 40) {
    session.cooldownUntil = now() + 8000
    session.ifiScore = 0
    setStatus('active')
    logEvent('drift_self_corrected', { ifi_score: ifi })
    broadcastState()
  }
}

function buildMetrics() {
  const stalls   = session.events.filter((e) => e.type === 'stall_detected')
  const drifts   = session.events.filter((e) => e.type === 'drift_detected')
  const restarts = session.events.filter((e) => e.type === 'task_restarted')
  const responses = session.events.filter((e) => e.type === 'intervention_response')

  const latencies = restarts.map((r) => Number(r.restart_latency_sec)).filter((n) => Number.isFinite(n))
  const medianRestartLatencySec = latencies.length
    ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)]
    : null

  const accepted = responses.filter((r) => r.accepted === true).length
  const acceptanceRate = responses.length ? accepted / responses.length : null

  const byType = { 'tab-loop': 0, 'dwell-freeze': 0, 'scroll-loop': 0, 'drift-escalated': 0 }
  for (const s of stalls) byType[s.stall_type] = (byType[s.stall_type] || 0) + 1

  const avgIfi = drifts.length
    ? Math.round(drifts.reduce((sum, d) => sum + (d.ifi_score || 0), 0) / drifts.length)
    : null

  return {
    medianRestartLatencySec,
    acceptanceRate,
    stallCounts: byType,
    totalStalls: stalls.length,
    totalDrifts: drifts.length,
    totalRestarts: restarts.length,
    avgDriftIfi: avgIfi,
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

// Auto-fail intervention if stall unresolved after 30s
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return

  if (msg.type === 'JARVIS_START_TASK') {
    session.taskName = (msg.payload?.taskName || '').trim()
    session.stallType = ''
    session.stallAt = null
    session.restartLatencySec = null
    session.lastTypingAt = now()
    session.tabSwitches = []
    session.ifiScore = 0
    setStatus('active')
    logEvent('task_started')
    broadcastState()
    sendResponse({ ok: true, session })
    return true
  }

  if (msg.type === 'JARVIS_SIGNAL_ACTIVITY') {
    const { typing = false, scrollDistance = 0, cursorEntropy = 0 } = msg.payload || {}
    if (!session.taskName) return sendResponse({ ok: true, session }), true

    if (typing) {
      session.lastTypingAt = now()
      session.ifiScore = 0

      if (session.status === 'stall') {
        handleRestart()
      } else if (session.status === 'drift') {
        // Typing during drift = self-correction, celebrate briefly
        session.cooldownUntil = now() + 8000
        setStatus('active')
        broadcastState()
      } else if (session.status !== 'active') {
        setStatus('active')
        broadcastState()
      }
      sendResponse({ ok: true, session })
      return true
    }

    const idleForMs = session.lastTypingAt ? now() - session.lastTypingAt : Infinity
    evaluateFromSignals({ idleForMs, scrollDistance, tabSwitchCount: getSwitchCount(), cursorEntropy })
    sendResponse({ ok: true, session })
    return true
  }

  if (msg.type === 'JARVIS_CONTINUE') {
    session.lastTypingAt = now()
    session.lastInterventionAccepted = true
    session.tabSwitches = []
    session.ifiScore = 0
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

  // User says "I'm good" during drift — self-corrected, reset IFI
  if (msg.type === 'JARVIS_DISMISS_DRIFT') {
    if (session.status !== 'drift') { sendResponse({ ok: true, session }); return true }
    session.lastTypingAt = now()
    session.ifiScore = 0
    session.cooldownUntil = now() + 8000
    setStatus('active')
    logEvent('drift_dismissed')
    broadcastState()
    sendResponse({ ok: true, session })
    return true
  }

  // User clicks "Help me start" during drift — escalate to stall with Layer 1 prompt
  if (msg.type === 'JARVIS_ESCALATE_DRIFT') {
    if (session.status !== 'drift') { sendResponse({ ok: true, session }); return true }
    session.stallType = 'drift-escalated'
    session.stallAt = now()
    session.currentPrompt = pickPrompt('drift-escalated')
    session.lastInterventionAt = new Date().toISOString()
    session.lastInterventionAccepted = null
    session.ifiScore = 100
    setStatus('stall')
    logEvent('drift_escalated_to_stall')
    broadcastState()
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
