# Jarvis MVP Demo (Frontend)

This Vite + React app simulates the Jarvis MVP wedge moment: an ambient co-presence bar that detects stall signals (tab switching, dwell without typing, scroll loops) and nudges the user back into motion.

## What this demo shows

- Floating Jarvis presence bar (ambient, non-intrusive)
- Activity sensing (typing, scroll, tab-switch simulation)
- Stall heuristic triggers and micro-interventions
- Restart reinforcement with activation latency metric

## Run locally

Use the existing frontend workspace. From the `frontend` directory:

```bash
npm install
npm run dev
```

Then open the dev server URL shown in the terminal.

## Demo flow

1. Enter a task in the floating Jarvis bar and click **Start**.
2. Type in the document to simulate active work.
3. Click **Simulate tab switch** repeatedly or scroll the document without typing to trigger a stall.
4. Use **Continue sentence** to restart and see the reinforcement prompt + latency metric.

## Notes

- All signals are local to the browser (no backend required for the wedge demo).
- Heuristics are intentionally simple to keep the MVP fast and believable.

## Chrome extension MVP (real in-browser overlay)

This repo now includes a real Manifest V3 extension at `frontend/extension`.

### Load unpacked in 2 minutes

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the folder: `frontend/extension`.

Jarvis will now appear as a floating co-presence bar on pages you open.

### Extension demo flow for investors

1. Open Google Docs or Notion.
2. Jarvis asks: **"What are you starting right now?"**
3. Enter `Q4 report` and click **Start**.
4. Type briefly to enter active mode.
5. Trigger stall by either:
	- switching tabs quickly several times, or
	- stopping typing for ~15s, or
	- scrolling repeatedly without typing.
6. Jarvis prompts restart and measures restart latency after you continue.

### What is tracked (MVP)

- Tab switch frequency window
- Time since typing
- Scroll distance without typing
- Stall event + restart latency (stored locally in extension storage)
