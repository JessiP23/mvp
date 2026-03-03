import { useEffect, useMemo, useState } from 'react'
import './App.css'

const STALL_RULES = {
  tabSwitchThreshold: 3,
  tabSwitchWindowMs: 45000,
  typingIdleMs: 15000,
  scrollDistanceThreshold: 2000,
}

// Pre-seeded stall history — matches real MVP data (avg ~340s without help)
const BASELINE_HISTORY = [
  { stallType: 'dwell without typing', latencySeconds: 362, isBaseline: true },
  { stallType: 'tab switch loop', latencySeconds: 318, isBaseline: true },
  { stallType: 'scroll loop', latencySeconds: 381, isBaseline: true },
]

// Layered micro-intervention prompts (behavioral science — atomize → commit)
const LAYER_PROMPTS = {
  layer1: {
    'tab switch loop': "What's one 30-second action? Like switching back to the doc.",
    'dwell without typing': "What's one sentence you can type right now—even badly?",
    'scroll loop': "Summarize in one line what you just read.",
  },
  layer2: "Give me 90 seconds. You can stop the moment you hate it.",
}

const STATUS_COPY = {
  idle: {
    label: 'idle presence',
    prompt: 'What are you starting right now?',
  },
  active: {
    label: 'active typing',
    prompt: "Continue sentence. I'm here.",
  },
  stall: {
    label: 'stall detected',
    prompt: 'Still working on',
  },
  restart: {
    label: 'restart reinforcement',
    prompt: 'Nice. You restarted in',
  },
}

const BASELINE_AVG = Math.round(
  BASELINE_HISTORY.reduce((sum, s) => sum + s.latencySeconds, 0) / BASELINE_HISTORY.length
)

function App() {
  const [taskInput, setTaskInput] = useState('')
  const [taskName, setTaskName] = useState('')
  const [status, setStatus] = useState('idle')
  const [stallReason, setStallReason] = useState('')
  const [lastTypingAt, setLastTypingAt] = useState(null)
  const [stallAt, setStallAt] = useState(null)
  const [restartLatency, setRestartLatency] = useState(null)
  const [tabSwitches, setTabSwitches] = useState([])
  const [scrollDistance, setScrollDistance] = useState(0)
  const [docValue, setDocValue] = useState('')
  const [now, setNow] = useState(Date.now())
  const [stallHistory, setStallHistory] = useState(BASELINE_HISTORY)
  const [stallElapsedSec, setStallElapsedSec] = useState(0)

  const recentTabSwitches = useMemo(() => {
    const n = Date.now()
    return tabSwitches.filter((timestamp) => n - timestamp < STALL_RULES.tabSwitchWindowMs)
  }, [tabSwitches])

  const sessionRestarts = useMemo(
    () => stallHistory.filter((s) => !s.isBaseline),
    [stallHistory]
  )

  const sessionAvg = useMemo(() => {
    if (!sessionRestarts.length) return null
    return Math.round(
      sessionRestarts.reduce((sum, s) => sum + s.latencySeconds, 0) / sessionRestarts.length
    )
  }, [sessionRestarts])

  const streak = useMemo(() => {
    let count = 0
    for (let i = stallHistory.length - 1; i >= 0; i--) {
      if (!stallHistory[i].isBaseline && stallHistory[i].latencySeconds < 150) count++
      else break
    }
    return count
  }, [stallHistory])

  useEffect(() => {
    if (!taskName) return
    const interval = setInterval(() => {
      const n = Date.now()
      const typingIdle = lastTypingAt ? n - lastTypingAt : 0
      const exceedsTabSwitches = recentTabSwitches.length > STALL_RULES.tabSwitchThreshold
      const exceedsTypingIdle = typingIdle > STALL_RULES.typingIdleMs
      const exceedsScroll = scrollDistance > STALL_RULES.scrollDistanceThreshold && typingIdle > 5000

      if (status === 'stall') return
      if (exceedsTabSwitches) {
        triggerStall('tab switch loop')
      } else if (exceedsTypingIdle) {
        triggerStall('dwell without typing')
      } else if (exceedsScroll) {
        triggerStall('scroll loop')
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [lastTypingAt, recentTabSwitches, scrollDistance, status, taskName])

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!taskName) return
    setStatus('active')
  }, [taskName])

  // Track elapsed seconds during stall for layer escalation (Layer 1 → Layer 2 at 45s)
  useEffect(() => {
    if (status !== 'stall' || !stallAt) {
      setStallElapsedSec(0)
      return
    }
    const interval = setInterval(() => {
      setStallElapsedSec(Math.round((Date.now() - stallAt) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [status, stallAt])

  const triggerStall = (reason) => {
    setStallReason(reason)
    setStatus('stall')
    setStallAt(Date.now())
  }

  const handleStart = () => {
    if (!taskInput.trim()) return
    setTaskName(taskInput.trim())
    setTaskInput('')
    setLastTypingAt(Date.now())
    setScrollDistance(0)
    setTabSwitches([])
    setStallReason('')
    setRestartLatency(null)
    setStallAt(null)
  }

  const handleRestart = () => {
    if (!stallAt) return
    const latencySeconds = Math.round((Date.now() - stallAt) / 1000)
    setRestartLatency(latencySeconds)
    setStallHistory((prev) => [
      ...prev,
      { stallType: stallReason, latencySeconds, isBaseline: false },
    ])
    setStatus('restart')
    setStallReason('')
    setStallAt(null)
    setTimeout(() => setStatus('active'), 3500)
  }

  const registerTyping = (value) => {
    setDocValue(value)
    setLastTypingAt(Date.now())
    setScrollDistance(0)
    if (status === 'stall') handleRestart()
    if (status !== 'active') setStatus('active')
  }

  const handleContinue = () => {
    setLastTypingAt(Date.now())
    setScrollDistance(0)
    if (status === 'stall') handleRestart()
    if (status !== 'active') setStatus('active')
  }

  const handleTabSwitch = () => {
    setTabSwitches((current) => [...current, Date.now()])
  }

  const handleScroll = (event) => {
    const { scrollTop } = event.currentTarget
    const lastScrollTop = Number(event.currentTarget.dataset.lastScrollTop || 0)
    const delta = Math.abs(scrollTop - lastScrollTop)
    event.currentTarget.dataset.lastScrollTop = scrollTop
    if (delta > 0) setScrollDistance((current) => current + delta)
  }

  const activeLayerPrompt =
    status === 'stall'
      ? stallElapsedSec < 45
        ? LAYER_PROMPTS.layer1[stallReason] ?? "What's one thing you can do in the next 30 seconds?"
        : LAYER_PROMPTS.layer2
      : null

  const activeLayerLabel =
    stallElapsedSec < 45 ? 'Layer 1 · Atomize task' : 'Layer 2 · 90s commitment'

  const chartMax = 400

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Jarvis MVP</p>
          <h1>Ambient activation layer for the moment you can't start</h1>
          <p className="subtitle">
            A tangible demo of the co-presence bar, stall detection heuristics, and restart
            reinforcement.
          </p>
        </div>
        <div className="metric-row">
          <div className="metric-card-sm">
            <p className="metric-title">Last restart</p>
            <p className="metric-value">{restartLatency != null ? `${restartLatency}s` : '--'}</p>
            <p className="metric-caption">Baseline avg: {BASELINE_AVG}s</p>
          </div>
          <div className="metric-card-sm">
            <p className="metric-title">Session avg</p>
            <p className="metric-value">{sessionAvg != null ? `${sessionAvg}s` : '--'}</p>
            <p className="metric-caption">
              {sessionAvg != null
                ? `↓ ${Math.round((1 - sessionAvg / BASELINE_AVG) * 100)}% vs baseline`
                : `vs ${BASELINE_AVG}s baseline`}
            </p>
          </div>
          <div className="metric-card-sm">
            <p className="metric-title">Streak</p>
            <p className="metric-value">{streak > 0 ? `${streak}×` : '--'}</p>
            <p className="metric-caption">Fast restarts in a row</p>
          </div>
        </div>
      </header>

      <section className="proof-strip">
        <h3>Activation latency per stall event</h3>
        <div className="chart-bars">
          <div className="bar-group">
            <div className="bar-group-bars">
              {BASELINE_HISTORY.map((s, i) => {
                const height = Math.max(
                  6,
                  Math.round((Math.min(s.latencySeconds, chartMax) / chartMax) * 80)
                )
                return (
                  <div key={i} className="bar-wrapper">
                    <div
                      className="latency-bar bar-baseline"
                      style={{ height: `${height}px` }}
                      title={`${s.latencySeconds}s — ${s.stallType}`}
                    />
                    <span className="bar-label">{s.latencySeconds}s</span>
                  </div>
                )
              })}
            </div>
            <span className="group-label">Before Jarvis</span>
          </div>

          <div className="chart-separator" />

          {sessionRestarts.length > 0 ? (
            <div className="bar-group">
              <div className="bar-group-bars">
                {sessionRestarts.map((s, i) => {
                  const height = Math.max(
                    6,
                    Math.round((Math.min(s.latencySeconds, chartMax) / chartMax) * 80)
                  )
                  const cls = s.latencySeconds < 150 ? 'bar-fast' : 'bar-slow'
                  return (
                    <div key={i} className="bar-wrapper">
                      <div
                        className={`latency-bar ${cls}`}
                        style={{ height: `${height}px` }}
                        title={`${s.latencySeconds}s — ${s.stallType}`}
                      />
                      <span className="bar-label">{s.latencySeconds}s</span>
                    </div>
                  )
                })}
              </div>
              <span className="group-label">With Jarvis</span>
            </div>
          ) : (
            <div className="chart-empty">
              <span>Interact with the demo below to see live data points →</span>
            </div>
          )}
        </div>
      </section>

      <section className="grid">
        <div className="panel">
          <div className="panel-header">
            <h2>Work surface</h2>
            <p>Use this area to simulate writing a document and scrolling.</p>
          </div>
          <div className="work-area" onScroll={handleScroll}>
            <div className="work-content">
              <p>
                {taskName
                  ? `Task: ${taskName}`
                  : "Start by telling Jarvis what you're working on."}
              </p>
              <textarea
                className="doc-input"
                placeholder="Start typing your first sentence..."
                value={docValue}
                onChange={(event) => registerTyping(event.target.value)}
              />
              <div className="filler">
                {Array.from({ length: 18 }).map((_, index) => (
                  <p key={index}>
                    This is a scrollable doc region to simulate rereading or avoidance loops. Keep
                    scrolling to see Jarvis notice the stall.
                  </p>
                ))}
              </div>
            </div>
          </div>
          <div className="actions">
            <button className="ghost" onClick={handleTabSwitch}>
              Simulate tab switch
            </button>
            <button className="primary" onClick={handleContinue}>
              Continue sentence
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Signals & heuristics</h2>
            <p>Simple, local rules. No ML needed for the wedge moment.</p>
          </div>
          <div className="signal-list">
            <div>
              <p className="signal-label">Recent tab switches</p>
              <p className="signal-value">{recentTabSwitches.length}</p>
              <span>Rule: &gt; {STALL_RULES.tabSwitchThreshold} in 45s</span>
            </div>
            <div>
              <p className="signal-label">Typing idle time</p>
              <p className="signal-value">
                {lastTypingAt ? `${Math.round((now - lastTypingAt) / 1000)}s` : '--'}
              </p>
              <span>Rule: &gt; {STALL_RULES.typingIdleMs / 1000}s</span>
            </div>
            <div>
              <p className="signal-label">Scroll distance</p>
              <p className="signal-value">{Math.round(scrollDistance)}px</p>
              <span>Rule: &gt; {STALL_RULES.scrollDistanceThreshold}px without typing</span>
            </div>
          </div>
          <div className="timeline">
            <h3>First 2 hours, compressed</h3>
            <ol>
              <li>
                <strong>Minute 0–2:</strong> Jarvis appears and asks what you're starting.
              </li>
              <li>
                <strong>Minute 5–15:</strong> Quiet co-presence while you type.
              </li>
              <li>
                <strong>Minute 30–60:</strong> Stall detected from dwell or tab switching.
              </li>
              <li>
                <strong>Hour 2:</strong> Reinforcement loop after restart.
              </li>
            </ol>
          </div>
        </div>
      </section>

      <aside className={`jarvis-bar ${status}`}>
        <div className="jarvis-indicator" />
        <div className="jarvis-copy">
          <p className="jarvis-label">{STATUS_COPY[status].label}</p>
          {status === 'idle' && (
            <div className="jarvis-input">
              <p>{STATUS_COPY.idle.prompt}</p>
              <div>
                <input
                  type="text"
                  value={taskInput}
                  onChange={(event) => setTaskInput(event.target.value)}
                  placeholder="Q4 report"
                />
                <button className="primary" onClick={handleStart}>
                  Start
                </button>
              </div>
            </div>
          )}
          {status === 'active' && <p>{STATUS_COPY.active.prompt}</p>}
          {status === 'stall' && (
            <div>
              <p>
                {STATUS_COPY.stall.prompt} <strong>{taskName || 'this task'}</strong>?
              </p>
              <span className="stall-reason">Detected: {stallReason}</span>
              {activeLayerPrompt && (
                <div className="layer-block">
                  <span className="layer-badge">{activeLayerLabel}</span>
                  <p className="layer-prompt">{activeLayerPrompt}</p>
                </div>
              )}
              <div className="jarvis-actions">
                <button className="ghost" onClick={() => setStatus('active')}>
                  Yes
                </button>
                <button className="primary" onClick={handleContinue}>
                  Continue sentence
                </button>
              </div>
            </div>
          )}
          {status === 'restart' && (
            <p>
              {STATUS_COPY.restart.prompt}{' '}
              <strong>{restartLatency != null ? `${restartLatency}s` : 'seconds'}</strong>.
              {streak > 0 && <span className="streak-badge">&nbsp;{streak}× streak</span>}
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}

export default App
