# Concrete Viewer — Claude Code Guide

## Project layout

```
concrete/
  vite.config.js        # Root Vite config — proxies /concrete/v3/* to v3 dev server
  v3/
    src/
      ConcreteViewer.jsx  # Main app shell: layout, state, toolbar, photo view
      ConcreteViewer.css  # All CSS
      MicroPanel.jsx      # Physics engine + particle canvas panels + ForcePanel
      MacroPanel.jsx      # Macro-scale illustration panels
    vite.config.js        # v3-specific Vite config
```

v1 and v2 are older versions; active work is in v3.

## Dev server

From the repo root:
```bash
cd /Users/jkremer/Projects/concrete
npm run dev          # starts root server + auto-spawns v3 dev server
```

App lives at `http://localhost:5174/concrete/v3/`

To build v3 (e.g. to update the served built assets):
```bash
cd /Users/jkremer/Projects/concrete/v3
npx vite build --mode development
```

## Architecture

### Physics (MicroPanel.jsx)

- `buildPhysics(ions, grains, lattices, crackWaypoints)` — constructs particles + bonds
- `stepPhysics(phys, force, speed, canBreak)` — spring-network integrator
- `MATRIX_SPACING = 16` — rest spacing between matrix atoms (world units)
- `VISUAL_SCALE = 4` — displacement amplification factor for educational visibility (but MicroPanelB always passes `visualScale=0` to drawScene, so particles render at rest positions)
- `FAULT_CORRIDOR = 18` — half-width of pre-weakened bond zone along crack path
- Bond types: `cc-near` (matrix-matrix), `cc-diag` (diagonal), `ss` (grain internal), `cs` (cement-sand interface)
- `bond.isFault` — pre-weakened bond on crack path (breaks at 20% of normal break strain)
- `bond.diagonal` — `|dx| > 2 && |dy| > 2`

### Rendering

- `drawScene(canvas, phys, crackFraction, crackWaypoints, ts, showDiag, visualScale, bondRound, showField)` — phase 1
- `drawPhase2Scene(canvas, phys, p2Progress, ts, showDiag, bondRound, hangStart, showField, crackWaypoints)` — phase 2 crack-opening animation
- Both called with `visualScale=0` in MicroPanelB → particles drawn at rest positions `(p.x0, p.y0)`
- Background color: `C.bg = '#ede8df'`

### Phase 2 displacement

- `buildPhase2Disps(particles, crackWaypoints, p2DispScale)` — assigns rightward displacement to particles on the RIGHT side of each crack segment, plus one layer of left-adjacent particles (within `FAULT_CORRIDOR` of crack path)
- `p2frac[i]` — animation start fraction (0–1); `>= 2` means particle never activates
- `p2disp[i]` — rightward displacement amount (world units)

### Force inspection (ForcePanel)

- Click any particle in a MicroPanelB canvas → selects it → ForcePanel shows force arrows
- `computeForceData(phys, idx)` — uses rest positions (x0, y0) for neighbor offsets; adds `diagonal`, `isFault`, `k`, `breakStrain`, `restLen` to each neighbor entry
- `ForcePanel` — SVG panel, `VR = MATRIX_SPACING * 3 = 48` world-unit viewport
- Arrow direction: toward neighbor for tension (strain ≥ 0), away for compression
- Arrow length: `MIN (4) + VR * 0.4 * |strain| / breakStrain` — always visible, grows with strain
- Broken bonds → arrow + neighbor circle disappear entirely
- Only orthogonal bonds shown (diagonal filtered out)
- Background matches main view: `C.bg`

### Click-to-select

- `handleCanvasClick` in MicroPanelB uses rest positions `p.x0, p.y0` for phase 1
- For phase 2: computes visual `xs[i] = p.x0 + p2disp[i] * eased` using current p2Progress, so clicks map to actual drawn positions
- Threshold: `particle.r + 4` world units (tight, requires clicking near visible circle)

### State flow (ConcreteViewer.jsx)

```
phase: 'idle' | 'testing' | 'settled' | 'failed'
scrubT: null | 0–1   — scrub handle position; null = live animation
selectedParticle: { panelId: 'red'|'blue'|'grey', idx: number } | null
forceData: computeForceData output | null
showField: bool — toggles bond strain visualization
```

Three `MicroPanelB` instances: red (cracked), blue (partial), grey (reference).
Each gets `selectedParticleIdx` and `onParticleClick` props; only the panel whose panelId matches the selection gets a non-null index.

## Key constants

| Constant | Value | Meaning |
|---|---|---|
| `VW / VH` | `288 / 256` | World canvas size (world units) |
| `MATRIX_SPACING` | `16` | Matrix atom grid spacing |
| `VISUAL_SCALE` | `4` | Displacement amplification |
| `FAULT_CORRIDOR` | `18` | Crack path weakness half-width |
| `FAULT_BREAK_FACTOR` | `0.20` | Fault bonds break at 20% of normal |
| `BOND_K cc-near` | `1.0` | Matrix-matrix stiffness |
| `C.bg` | `'#ede8df'` | Warm off-white background |
