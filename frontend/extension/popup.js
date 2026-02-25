function fmt(v, suffix = '') {
  return v === null || v === undefined ? '—' : `${v}${suffix}`
}

function renderSummary(summary) {
  document.getElementById('latency').textContent = fmt(summary?.medianRestartLatencySec, 's')
  document.getElementById('acceptance').textContent = fmt(summary?.interventionAcceptanceRate, '%')

  const stalls = document.getElementById('stalls')
  stalls.innerHTML = ''
  for (const row of summary?.stallsByType || []) {
    const div = document.createElement('div')
    div.className = 'row'
    div.textContent = `${row.type}: ${row.count} (${row.percent}%)`
    stalls.appendChild(div)
  }

  const timeline = document.getElementById('timeline')
  timeline.innerHTML = ''
  for (const e of summary?.timeline || []) {
    const li = document.createElement('li')
    li.textContent = `${e.type} • ${e.stall_type || '-'} • ${new Date(e.timestamp).toLocaleTimeString()}`
    timeline.appendChild(li)
  }
}

async function loadSummary() {
  const res = await chrome.runtime.sendMessage({ type: 'JARVIS_GET_METRICS_SUMMARY' })
  renderSummary(res?.summary || {})
}

function downloadCsv(csvText) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  chrome.downloads.download({
    url,
    filename: `jarvis-events-${Date.now()}.csv`,
    saveAs: true,
  })
}

async function loadDemoMode() {
  const r = await chrome.storage.local.get(['jarvisDemoMode'])
  document.getElementById('demoMode').checked = Boolean(r.jarvisDemoMode)
}

document.getElementById('demoMode')?.addEventListener('change', async (e) => {
  const enabled = Boolean(e.target.checked)
  await chrome.storage.local.set({ jarvisDemoMode: enabled })
})

document.getElementById('resetData')?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'JARVIS_RESET_EVENT_LOG' })
  await loadSummary()
})

document.getElementById('exportCsv').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'JARVIS_EXPORT_CSV' })
  if (res?.csv) downloadCsv(res.csv)
})

loadSummary()
loadDemoMode()