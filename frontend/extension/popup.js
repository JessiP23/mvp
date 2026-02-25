function send(type, payload = {}) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, resolve))
}

function pct(v) {
  if (v == null) return '-'
  return `${Math.round(v * 100)}%`
}

function downloadCsv(rows) {
  const headers = Object.keys(rows[0] || {})
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push(headers.map((h) => JSON.stringify(r[h] ?? '')).join(','))
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `jarvis-events-${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

async function render() {
  const res = await send('JARVIS_GET_METRICS')
  if (!res?.ok) return

  const { metrics, tone } = res
  document.getElementById('latency').textContent = metrics.medianRestartLatencySec ? `${metrics.medianRestartLatencySec}s` : '-'
  document.getElementById('acceptance').textContent = pct(metrics.acceptanceRate)
  document.getElementById('tabloop').textContent = metrics.stallCounts['tab-loop'] || 0
  document.getElementById('dwell').textContent = metrics.stallCounts['dwell-freeze'] || 0
  document.getElementById('scroll').textContent = metrics.stallCounts['scroll-loop'] || 0
  document.getElementById('tone').value = tone

  const timeline = document.getElementById('timeline')
  timeline.innerHTML = ''

  function toLocal(ts) {
    const d = new Date(ts)
    return d.toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    })
  }

  for (const e of metrics.timeline) {
    const div = document.createElement('div')
    div.className = 'item'
    const when = e.ts ? toLocal(e.ts) : '-'
    div.textContent = `${when} — ${e.type}${e.stall_type ? ` (${e.stall_type})` : ''}`
    timeline.appendChild(div)
  }
}

document.getElementById('tone').addEventListener('change', async (e) => {
  await send('JARVIS_SET_TONE', { tone: e.target.value })
  render()
})

document.getElementById('exportCsv').addEventListener('click', async () => {
  const res = await send('JARVIS_EXPORT_EVENTS')
  if (res?.ok) downloadCsv(res.events || [])
})

render()