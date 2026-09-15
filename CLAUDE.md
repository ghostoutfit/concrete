# Concrete Viewer — Claude Code Guide

## Project layout

```
concrete/
  vite.config.js        # Root Vite config — proxies /concrete/v4/* to v4 dev server
  v4/
    src/
      ConcreteViewer.jsx  # Main app shell: layout, state, toolbar, photo view, manual mode
      ConcreteViewer.css  # All CSS
      MicroPanel.jsx      # Physics engine + particle canvas panels + ForcePanel
    vite.config.js        # v4-specific Vite config
  public/v4/            # Built assets served statically
```

v1–v3 are older versions; active work is in v4.

## Dev server

From the repo root:
```bash
cd /Users/jkremer/Projects/concrete
npm run dev          # starts root server + auto-spawns v4 dev server
```

App lives at `http://localhost:5174/concrete/v4/`

To build v4 (updates the served built assets):
```bash
cd /Users/jkremer/Projects/concrete/v4
npx vite build --mode development
```

## Architecture

### Physics (MicroPanel.jsx)

- `buildPhysics(ions, grains, lattices, widthMul, isBlue, crackWaypoints, faultBreakFactor)` — constructs particles + bonds
- `stepPhysics(phys, force, dt, canBreak)` — spring-network integrator; `canBreak=true` always (gate removed)
- `MATRIX_SPACING = 16` — rest spacing between matrix atoms (world units)
- `VISUAL_SCALE = 4` — displacement amplification (MicroPanelB always passes `visualScale=0`)
- `FAULT_CORRIDOR = 18` — half-width of pre-weakened bond zone along crack path
- Bond types: `cc-near`, `cc-diag`, `ss` (grain internal), `cs` (cement-sand interface)
- `bond.isFault` — pre-weakened bond; break strain = `faultBreakFactor * normalBreakStrain`
- `MAX_PUNCH_DISP` — maximum punch displacement (world units); exported for manual mode

### Force display calibration (ConcreteViewer.jsx top-level constants)

```js
SAND_BREAK_KN  = { 0: 600, 20: 650, 40: 750, 60: 900, 80: 400 }   // target mean display kN
SAND_BREAK_VAR = { 0: 0.40, 20: 0.20, 40: 0.10, 60: 0.10, 80: 0.10 } // target CV (±%)
SAND_FAULT_BREAK = { ... }   // per-ratio fault bond break factor
OBSERVED_MEAN_KN = { ... }   // empirical internalKN mean from manual pre-run physics
OBSERVED_STD_KN  = { ... }   // empirical internalKN std from manual pre-run physics
SAND_KN_SCALE    = { ... }   // rising-animation linear scale (pre-break LCD)
```

**Z-score remap** (live test break + manual mode break):
```
z = Math.tanh((internalKN - OBSERVED_MEAN_KN[pct]) / OBSERVED_STD_KN[pct])
displayKN = SAND_BREAK_KN[pct] * (1 + z * SAND_BREAK_VAR[pct])
```
This maps raw physics output to the target display range, bounded by ±`SAND_BREAK_VAR`.

### Manual force mode

- Recording built in `useEffect([controlTab, layoutSeed])`:
  1. Fine pre-run (unit steps 1→MANUAL_MAX_N) finds `preBreakN` for all ratios
  2. Z-score remap → `targetDisplayKN` → `effectiveScale = targetDisplayKN * MANUAL_MAX_N / (2500 * preBreakN)`
  3. Coarse recording loop at `manualStep = 20 * MANUAL_MAX_N / (2500 * effectiveScale)` — each step shows exactly 20 kN
- `MANUAL_MAX_N = 600` — total steps in the force range
- LCD at break: `Math.round((foundBreakN / MANUAL_MAX_N) * 2500 * manualEffectiveScale)`
- `manualForceStep` uses `manualEffectiveScale ?? kNScale` (same scale as LCD)

### Calibration console tools

- `runBreakTests(count=10)` — batch live-physics break test; outputs per-ratio range/avg/target
- `runManualTests(count=10)` — simulates exact manual LCD break values in bulk; outputs `iKN mean/std` alongside `const mean` for tuning `OBSERVED_MEAN_KN`

To recalibrate: run `runManualTests(50)`, compare `iKN mean` to `const mean` column, update `OBSERVED_MEAN_KN` and `OBSERVED_STD_KN` to match actual physics.

### Dev mode

Type `dev` anywhere in the app to toggle dev sliders. After running `runBreakTests()`, a histogram overlay appears showing the break force distribution per sand ratio.

### Rendering

- `drawScene(canvas, phys, crackFraction, crackWaypoints, ts, showDiag, visualScale, bondRound, showField)` — phase 1
- `drawPhase2Scene(...)` — phase 2 crack-opening animation
- Background color: `C.bg = '#ede8df'`

### State flow (ConcreteViewer.jsx)

```
phase: 'idle' | 'testing' | 'settled' | 'failed'
controlTab: 'test' | 'manual'
scrubT: null | 0–1          — scrub handle; null = live animation
manualForceN: 0–MANUAL_MAX_N
manualBreakN: number | null  — step at which bonds broke in recording
manualEffectiveScale: number | null  — per-seed scale; null until recording built
showField: bool             — bond strain visualization toggle (works in all tabs)
```

### Phase 2 displacement

- `buildPhase2Disps(particles, crackWaypoints, p2DispScale)` — assigns rightward displacement to particles right of crack
- `p2frac[i]` — animation start fraction; `>= 2` means never activates

### Force inspection (ForcePanel)

- Click any particle → selects it → ForcePanel shows force arrows
- `computeForceData(phys, idx)` — uses rest positions for neighbor offsets
- Arrow direction: toward neighbor for tension, away for compression
- Broken bonds → disappear; diagonal bonds filtered out

## Key constants

| Constant | Value | Meaning |
|---|---|---|
| `VW / VH` | `288 / 256` | World canvas size (world units) |
| `MATRIX_SPACING` | `16` | Matrix atom grid spacing |
| `VISUAL_SCALE` | `4` | Displacement amplification |
| `FAULT_CORRIDOR` | `18` | Crack path weakness half-width |
| `MANUAL_MAX_N` | `600` | Manual mode force range (steps) |
| `C.bg` | `'#ede8df'` | Warm off-white background |
