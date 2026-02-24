import { useEffect, useMemo, useState } from 'react'
import './App.css'

const STALL_RULES = {
  tabSwitchThreshold: 3,
  tabSwitchWindowMs: 45000,
  typingIdleMs: 15000,
  scrollDistanceThreshold: 2000,
}

const STATUS_COPY = {
  idle: {
    label: 'idle presence',
    prompt: 'What are you starting right now?',
  },
  active: {
    label: 'active typing',
    prompt: 'Continue sentence. I\'m here.',
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

  const recentTabSwitches = useMemo(() => {
    const now = Date.now()
    return tabSwitches.filter((timestamp) => now - timestamp < STALL_RULES.tabSwitchWindowMs)
  }, [tabSwitches])

  useEffect(() => {
    if (!taskName) return
    const interval = setInterval(() => {
      const now = Date.now()
      const typingIdle = lastTypingAt ? now - lastTypingAt : 0
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

  const registerTyping = (value) => {
    setDocValue(value)
    setLastTypingAt(Date.now())
    setScrollDistance(0)
    if (status === 'stall') handleRestart()
    if (status !== 'active') setStatus('active')
  }

  const handleRestart = () => {
    if (!stallAt) return
    const latencySeconds = Math.round((Date.now() - stallAt) / 1000)
    setRestartLatency(latencySeconds)
    setStatus('restart')
    setStallReason('')
    setStallAt(null)
    setTimeout(() => setStatus('active'), 3500)
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Jarvis MVP</p>
          <h1>Ambient activation layer for the moment you can\'t start</h1>
          <p className="subtitle">
            A tangible demo of the co-presence bar, stall detection heuristics, and restart reinforcement.
          </p>
        </div>
        <div className="metric-card">
          <p className="metric-title">Activation latency</p>
          <p className="metric-value">{restartLatency ? `${restartLatency}s` : '--'}</p>
          <p className="metric-caption">Goal: median under 30s</p>
        </div>
      </header>

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
                  : 'Start by telling Jarvis what you\'re working on.'}
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
                <strong>Minute 0–2:</strong> Jarvis appears and asks what you\'re starting.
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
              <strong>{restartLatency ? `${restartLatency}s` : 'seconds'}</strong>.
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}

export default App
