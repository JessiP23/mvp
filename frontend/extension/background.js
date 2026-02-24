const TAB_SWITCH_WINDOW_MS = 45_000
const TAB_SWITCH_THRESHOLD = 3

const tabSwitchesByWindow = new Map()

function pruneOldSwitches(timestamps, now = Date.now()) {
  return timestamps.filter((time) => now - time <= TAB_SWITCH_WINDOW_MS)
}

function pushTabSwitch(windowId) {
  const now = Date.now()
  const current = tabSwitchesByWindow.get(windowId) || []
  const next = pruneOldSwitches([...current, now], now)
  tabSwitchesByWindow.set(windowId, next)
  return next.length
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId, windowId } = activeInfo
  const switchCount = pushTabSwitch(windowId)

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'JARVIS_TAB_ACTIVITY',
      payload: {
        switchCount,
        threshold: TAB_SWITCH_THRESHOLD,
        windowMs: TAB_SWITCH_WINDOW_MS,
      },
    })
  } catch {
    // Ignore messaging errors for tabs without content-script context.
  }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'JARVIS_LOG_EVENT') {
    const key = 'jarvisEventLog'
    chrome.storage.local.get([key], (result) => {
      const current = Array.isArray(result[key]) ? result[key] : []
      const next = [...current.slice(-199), message.payload]
      chrome.storage.local.set({ [key]: next }, () => sendResponse({ ok: true }))
    })

    return true
  }

  if (message?.type === 'JARVIS_GET_EVENT_LOG') {
    chrome.storage.local.get(['jarvisEventLog'], (result) => {
      sendResponse({ events: result.jarvisEventLog || [] })
    })
    return true
  }

  return false
})
