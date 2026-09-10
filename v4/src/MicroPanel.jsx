import { useState, useMemo, useRef, useEffect, useLayoutEffect } from 'react'

export const VW = 600
export const VH = 350
export const MATRIX_SPACING = 16
const H_STEP = MATRIX_SPACING * 2
const V_STEP = MATRIX_SPACING
const SI_PAD = MATRIX_SPACING / 2

// ── Physics constants ──────────────────────────────────────────
// Horizontal tension: left edge fixed, right edge pulled rightward.
// Models the top-surface tension zone of a cantilever near its fixed end.
// Crack runs top-to-bottom through the fault corridor (same as compression,
// but the driving force is horizontal stretch, not vertical squish).
const GAMMA           = 0.003  // overdamped drag — equilibrates in <1 frame at this setting
const SUBSTEPS        = 30
const DT              = 1/60
export const MAX_PUNCH_DISP  = 12     // max total stretch (right-edge, top) in SVG units
const PUNCH_RAMP      = 0.04   // SVG units per frame
const VISUAL_SCALE    = 4      // amplify displacements for visibility (reduced so right edge stays on screen)
const SETTLE_VEL      = 0.08
const SETTLE_FRAMES   = 15
const FORCE_RAMP_RATE = 0.004  // per frame — ~4s to reach full force at 60fps
export const FRACTURE_THRESHOLD = 0.45  // force fraction below which bonds never break (elastic only)

// Bond spring constants and break strains
const BOND_K = {
  'cc-near': 1.0,
  'cc-diag': 0.4,
  'ss':      3.0,
  'cs':      0.5,
}
// Break strains calibrated for MAX_PUNCH_DISP=8, chain 18×16=288 px:
//   uniform strain at full load = 8/288 = 2.78%
//   cc-near non-weakened (3.5%) > 2.78% → bulk matrix survives full load
//   cc-near pre-weakened  (1.75%) → fails at D=1.75%×288=5.04 → 63% force ✓
//   cc-diag non-weakened (2.0%) — survives; pre-weakened (1.0%) — fails ~80% force
const BOND_BREAK = {
  'cc-near': 0.035,
  'cc-diag': 0.020,
  'ss':      0.08,
  'cs':      0.010,  // weaker than bulk cement — interface debonds before cement cracks
}
const P2_SNAP_RAMP = 0.40  // fraction of Phase 2 each particle spends sliding; wide so many rows overlap
const P2_JITTER    = 0.05  // per-particle random offset breaks row synchronisation
const NEAR_BOND  = MATRIX_SPACING * 1.15           // ~18.4 px
const DIAG_BOND  = MATRIX_SPACING * Math.SQRT2 * 1.1 // ~24.9 px
const GRAIN_BOND = H_STEP + 4                      // 36 px  (max intra-grain)
const IFACE_BOND = MATRIX_SPACING * 1.7            // ~27 px

// Continuous strain colour: near-bg → navy → amber → red.
// Stops are front-loaded so bonds ramp to strong colour at small strain fractions.
export const COLOR_STOPS = [
  [0.00, 200, 196, 188],  // light warm grey — visible on dark bg
  [0.20, 195,  90, 255],  // bright violet
  [0.55, 240,  30, 225],  // vivid magenta-purple
  [1.00, 255,  70, 185],  // hot pink — at break
]
export const COLOR_STOPS_LIGHT = [
  [0.00, 172, 167, 160],  // warm grey
  [0.20, 190, 100, 220],  // light purple
  [0.55, 150,  20, 200],  // deep purple
  [1.00, 255,  40, 160],  // hot pink
]

export function strainColor(strain, breakStrain, dark = true) {
  const stops = dark ? COLOR_STOPS : COLOR_STOPS_LIGHT
  const t = Math.min(1, Math.abs(strain) / (breakStrain * 0.45))
  for (let k = 0; k < stops.length - 1; k++) {
    const [t0, r0, g0, b0] = stops[k]
    const [t1, r1, g1, b1] = stops[k + 1]
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0)
      return `rgb(${Math.round(r0+(r1-r0)*u)},${Math.round(g0+(g1-g0)*u)},${Math.round(b0+(b1-b0)*u)})`
    }
  }
  return `rgb(255,0,0)`
}

// ── Crack fault-line constants ─────────────────────────────────
// The crack path is predetermined from grain geometry (v1 algorithm).
// Bonds within FAULT_CORRIDOR px of the path are pre-weakened so the
// fault activates under any load — even a small force strains fault
// bonds visibly while bulk bonds stay near-zero.
const FAULT_CORRIDOR    = 18    // px half-width of weak zone
const FAULT_K_FACTOR    = 0.30  // fault bonds 70% softer → stretch more per unit load
const FAULT_BREAK_FACTOR = 0.20  // fault bonds break at 20% of normal strain — low enough to crack ~65% deep with kinematic field

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function distToPath(px, py, waypoints) {
  let minD = Infinity
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1]
    minD = Math.min(minD, distToSegment(px, py, a.x, a.y, b.x, b.y))
  }
  return minD
}

// ── Micro crack routing ────────────────────────────────────────
// Returns waypoints array [{x,y}] — used both for bond pre-weakening
// and for SVG rendering via smoothPath.
function smoothPath(pts) {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i]
    const dy = p1.y - p0.y
    const cy1 = (p0.y + dy * 0.35).toFixed(1)
    const cy2 = (p1.y - dy * 0.35).toFixed(1)
    d += ` C ${p0.x.toFixed(1)},${cy1} ${p1.x.toFixed(1)},${cy2} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`
  }
  return d
}

export function buildCrackWaypoints(grains, sandPct = 0) {
  const midX = VW / 2
  if (grains.length === 0) return [{ x: midX, y: 0 }, { x: midX, y: VH }]

  const obs = grains.map(g => ({ x1: g.x, x2: g.x + g.w, y1: g.y, y2: g.y + g.h }))

  // Strict-interior checks — paths ON grain faces are allowed
  function vBlocked(px, ya, yb) {
    return obs.some(o => px > o.x1 && px < o.x2 && ya < o.y2 && yb > o.y1)
  }
  function hBlocked(py, xa, xb) {
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb)
    return obs.some(o => py > o.y1 && py < o.y2 && lo < o.x2 && hi > o.x1)
  }
  // Cement cost of a horizontal segment: zero for portions along a grain top/bottom face.
  function hCost(py, xa, xb) {
    let len = Math.abs(xb - xa)
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb)
    for (const o of obs) {
      if (py === o.y1 || py === o.y2)
        len -= Math.max(0, Math.min(hi, o.x2) - Math.max(lo, o.x1))
    }
    return Math.max(0, len)
  }
  // Cement cost of a vertical segment: zero for portions running along a grain
  // left/right face (Si-OH bonds break there).
  function vCost(px, ya, yb) {
    let len = yb - ya
    for (const o of obs) {
      if (px === o.x1 || px === o.x2)
        len -= Math.max(0, Math.min(yb, o.y2) - Math.max(ya, o.y1))
    }
    return Math.max(0, len)
  }

  // Crop boundaries — grain faces on these lines have edge-protected (unbreakable) bonds,
  // so the trajectory must stay strictly inside and never seek those faces.
  const CROP_X0 = (VW - VH) / 2
  const CROP_X1 = (VW + VH) / 2

  // Graph nodes: start + grain corners that are strictly inside the crop window
  const nodes = [{ x: midX, y: 0 }]
  for (const o of obs) {
    for (const [nx, ny] of [[o.x1, o.y1], [o.x2, o.y1], [o.x1, o.y2], [o.x2, o.y2]]) {
      if (nx > CROP_X0 && nx < CROP_X1) nodes.push({ x: nx, y: ny })
    }
  }
  const N = nodes.length

  // Edge cost: penalise cement traversal, reward grain-face traversal.
  // Grain vertical faces carry Si-OH bonds — we actively want to cut those.
  // No face bonus for faces at the crop boundary (bonds there are unbreakable).
  // No negative cycles exist (we only move downward), so Bellman-Ford is safe.
  const FACE_BONUS = 10.0  // reward per px of vertical grain-face traversal
  function edgeCost(ux, uy, vx, vy) {
    const vCem  = vCost(vx, uy, vy)
    const insideCrop = vx > CROP_X0 && vx < CROP_X1
    const vFace = insideCrop ? (vy - uy) - vCem : 0
    return hCost(uy, ux, vx) + vCem - FACE_BONUS * vFace
  }

  const dist = new Float32Array(N).fill(1e9)
  const prev = new Int32Array(N).fill(-1)
  dist[0] = 0

  // Bellman-Ford — O(N³), N ≤ ~25 so trivially fast; handles negative edge costs
  for (let iter = 0; iter < N - 1; iter++) {
    let changed = false
    for (let u = 0; u < N; u++) {
      if (dist[u] >= 1e9) continue
      const { x: ux, y: uy } = nodes[u]
      for (let v = 0; v < N; v++) {
        if (u === v) continue
        const { x: vx, y: vy } = nodes[v]
        if (vy < uy) continue                              // only move downward
        if (hBlocked(uy, ux, vx)) continue                // horizontal leg blocked
        if (vy > uy && vBlocked(vx, uy, vy)) continue     // vertical leg blocked
        const cost = edgeCost(ux, uy, vx, vy)
        if (dist[u] + cost < dist[v]) { dist[v] = dist[u] + cost; prev[v] = u; changed = true }
      }
    }
    if (!changed) break
  }

  // Best terminal: minimum total cost including final vertical drop to y=VH
  let bestU = -1, bestD = 1e9
  for (let i = 0; i < N; i++) {
    if (vBlocked(nodes[i].x, nodes[i].y, VH)) continue
    const { x: tx, y: ty } = nodes[i]
    const total = dist[i] + edgeCost(tx, ty, tx, VH)
    if (total < bestD) { bestD = total; bestU = i }
  }
  if (bestU < 0) return [{ x: midX, y: 0 }, { x: midX, y: VH }]

  // Trace back
  const path = []
  for (let cur = bestU; cur >= 0; cur = prev[cur]) path.unshift(nodes[cur])

  // Emit waypoints; insert horizontal transition point wherever x changes
  const waypoints = []
  for (let i = 0; i < path.length; i++) {
    waypoints.push({ x: path[i].x, y: path[i].y })
    if (i + 1 < path.length && Math.abs(path[i].x - path[i + 1].x) > 0.5)
      waypoints.push({ x: path[i + 1].x, y: path[i].y })
  }
  waypoints.push({ x: path[path.length - 1].x, y: VH })
  return waypoints
}

// Route the crack through actual cs bond midpoints grouped by grain face column.
// Called inside buildPhysics after bonds are built and stamped.
function computeCrackPath(bonds, particles) {
  const midX = VW / 2
  const CROP_X0 = (VW - VH) / 2
  const CROP_X1 = (VW + VH) / 2

  // Group non-diagonal inCrop non-edgeProtected cs bond midpoints by x column (grain face)
  const faceMap = new Map()
  for (const b of bonds) {
    if (b.diagonal || !b.inCrop || b.edgeProtected || b.type !== 'cs') continue
    const pi = particles[b.i], pj = particles[b.j]
    const mx = (pi.x0 + pj.x0) / 2
    const my = (pi.y0 + pj.y0) / 2
    if (mx <= CROP_X0 + MATRIX_SPACING * 2 || mx >= CROP_X1 - MATRIX_SPACING * 2) continue
    const key = Math.round(mx * 4)               // round to nearest 0.25 px — bonds on same face share exact x
    if (!faceMap.has(key)) faceMap.set(key, { x: mx, minY: my, maxY: my })
    else { const f = faceMap.get(key); f.minY = Math.min(f.minY, my); f.maxY = Math.max(f.maxY, my) }
  }

  if (faceMap.size === 0) return [{ x: midX, y: 0 }, { x: midX, y: VH }]
  const faces = Array.from(faceMap.values())

  // Nodes: source + (top, bottom) of each grain-face column
  const nodes = [{ x: midX, y: 0 }]
  for (const f of faces) {
    nodes.push({ x: f.x, y: f.minY }, { x: f.x, y: f.maxY })
  }
  const N = nodes.length

  const H_PENALTY  = 3   // cost per px horizontal (cement gap between faces)
  const FACE_BONUS = 10  // reward per px vertical grain-face traversal (Si-OH bonds)

  function edgeCost(ux, uy, vx, vy) {
    const f    = faceMap.get(Math.round(vx * 4))
    const face = f ? Math.max(0, Math.min(vy, f.maxY) - Math.max(uy, f.minY)) : 0
    return Math.abs(vx - ux) * H_PENALTY + (vy - uy - face) - FACE_BONUS * face
  }

  const dist = new Float32Array(N).fill(1e9)
  const prev = new Int32Array(N).fill(-1)
  dist[0] = 0

  // Bellman-Ford on downward DAG — no negative cycles possible
  for (let iter = 0; iter < N - 1; iter++) {
    let changed = false
    for (let u = 0; u < N; u++) {
      if (dist[u] >= 1e9) continue
      const { x: ux, y: uy } = nodes[u]
      for (let v = 0; v < N; v++) {
        if (u === v) continue
        const { x: vx, y: vy } = nodes[v]
        if (vy <= uy) continue
        const cost = edgeCost(ux, uy, vx, vy)
        if (dist[u] + cost < dist[v]) { dist[v] = dist[u] + cost; prev[v] = u; changed = true }
      }
    }
    if (!changed) break
  }

  // Best terminal: min (path cost + remaining cement tail to VH)
  let bestU = -1, bestD = 1e9
  for (let i = 1; i < N; i++) {
    if (dist[i] >= 1e9) continue
    const total = dist[i] + (VH - nodes[i].y)
    if (total < bestD) { bestD = total; bestU = i }
  }
  if (bestU < 0) return [{ x: midX, y: 0 }, { x: midX, y: VH }]

  const path = []
  for (let cur = bestU; cur >= 0; cur = prev[cur]) path.unshift(nodes[cur])

  const waypoints = []
  for (let i = 0; i < path.length; i++) {
    waypoints.push({ x: path[i].x, y: path[i].y })
    if (i + 1 < path.length && Math.abs(path[i].x - path[i + 1].x) > 0.5)
      waypoints.push({ x: path[i + 1].x, y: path[i].y })
  }
  waypoints.push({ x: path[path.length - 1].x, y: VH })
  return waypoints
}

// ── Blue view grain + crack (big grain stops crack) ───────────
const BIG_GRAIN_COLS = 7
const BIG_GRAIN_ROWS = 5

export function buildBlueGrains(sandPct, seed) {
  const { w: bw, h: bh } = grainDims(BIG_GRAIN_COLS, BIG_GRAIN_ROWS)
  const bx0 = Math.round((VW / 2 - bw / 2) / MATRIX_SPACING) * MATRIX_SPACING
  const by0 = Math.round((VH / 2 - bh / 2) / MATRIX_SPACING) * MATRIX_SPACING
  const bx = ((bx0 / MATRIX_SPACING + by0 / MATRIX_SPACING) % 2 === 0) ? bx0 : bx0 + MATRIX_SPACING
  const bigGrain = { x: bx, y: by0, w: bw, h: bh, id: 999, siCols: BIG_GRAIN_COLS, siRows: BIG_GRAIN_ROWS, isBig: true }

  const regular = buildGrains(sandPct, seed)
  const pad = 20
  const filtered = regular.filter(g =>
    g.x + g.w + pad < bigGrain.x || g.x > bigGrain.x + bigGrain.w + pad ||
    g.y + g.h + pad < bigGrain.y || g.y > bigGrain.y + bigGrain.h + pad
  )
  return [...filtered, bigGrain]
}

export function buildBlueCrackWaypoints(blueGrains) {
  const bigGrain = blueGrains.find(g => g.isBig)
  if (!bigGrain) return [{ x: VW / 2, y: 0 }, { x: VW / 2, y: VH }]
  const targetX = bigGrain.x + bigGrain.w / 2
  return [{ x: VW / 2, y: 0 }, { x: targetX, y: bigGrain.y }]
}

// ── Seeded PRNG ────────────────────────────────────────────────
function makeRand(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 }
}

// ── Grain layout (same as before) ─────────────────────────────
const GRAIN_CFG = {
  0:  { count: 0,  minCols: 0, maxCols: 0, minRows: 0, maxRows: 0, pad: MATRIX_SPACING },
  20: { count: 3,  minCols: 3, maxCols: 6, minRows: 2, maxRows: 5, pad: MATRIX_SPACING },
  40: { count: 6,  minCols: 3, maxCols: 6, minRows: 2, maxRows: 5, pad: MATRIX_SPACING },
  60: { count: 11, minCols: 3, maxCols: 6, minRows: 2, maxRows: 5, pad: MATRIX_SPACING },
  // 80%: larger grains packed tight — negative pad lets exclusion zones overlap so
  // adjacent grains have no cement matrix between them
  80: { count: 22, minCols: 4, maxCols: 9, minRows: 3, maxRows: 7, pad: -SI_PAD },
}
function grainDims(siCols, siRows) {
  return {
    w: (siCols - 1) * H_STEP + SI_PAD * 2,
    h: (siRows - 1) * 2 * V_STEP + SI_PAD * 2,
  }
}

export function buildGrains(sandPct, seed) {
  const cfg = GRAIN_CFG[sandPct]
  if (!cfg || cfg.count === 0) return []
  const rand = makeRand(seed)
  const grains = []
  const PAD = cfg.pad ?? MATRIX_SPACING

  for (let i = 0; i < cfg.count; i++) {
    const siCols = cfg.minCols + Math.round(rand() * (cfg.maxCols - cfg.minCols))
    const siRows = cfg.minRows + Math.round(rand() * (cfg.maxRows - cfg.minRows))
    const { w, h } = grainDims(siCols, siRows)

    for (let attempt = 0; attempt < 300; attempt++) {
      const x0 = Math.round(rand() * (VW - w) / MATRIX_SPACING) * MATRIX_SPACING
      const y0 = Math.round(rand() * (VH - h) / MATRIX_SPACING) * MATRIX_SPACING
      // Phase-align so grain boundary O atoms face matrix Ca atoms (not matrix O)
      const x = ((x0 / MATRIX_SPACING + y0 / MATRIX_SPACING) % 2 === 0) ? x0 : x0 + MATRIX_SPACING

      if (x < 0 || x + w > VW || y0 < 0 || y0 + h > VH) continue
      if (grains.some(g =>
        x < g.x + g.w + PAD && x + w + PAD > g.x &&
        y0 < g.y + g.h + PAD && y0 + h + PAD > g.y
      )) continue

      grains.push({ x, y: y0, w, h, id: i, siCols, siRows })
      break
    }
  }

  return grains
}

export function buildLattice(g) {
  const { siCols, siRows } = g
  const nodes = []
  for (let si = 0; si < siRows; si++) {
    const y = g.y + SI_PAD + si * 2 * V_STEP
    for (let sc = 0; sc < siCols; sc++) {
      const x = g.x + SI_PAD + sc * H_STEP
      nodes.push({ x, y, type: 'Si' })
      if (sc < siCols - 1) nodes.push({ x: x + H_STEP / 2, y, type: 'O' })
    }
    if (si < siRows - 1) {
      const yO = y + V_STEP
      for (let sc = 0; sc < siCols; sc++) {
        nodes.push({ x: g.x + SI_PAD + sc * H_STEP, y: yO, type: 'O' })
      }
    }
  }
  // Remove O atoms whose nearest grid-distance neighbours are all O (no Si within one cell)
  return nodes.filter(n =>
    n.type !== 'O' ||
    nodes.some(m => m.type === 'Si' && Math.hypot(m.x - n.x, m.y - n.y) <= MATRIX_SPACING + 1)
  )
}

export function buildIons(grains) {
  const ions = []
  function inGrain(x, y) {
    return grains.some(g =>
      x > g.x - SI_PAD && x < g.x + g.w + SI_PAD &&
      y > g.y - SI_PAD && y < g.y + g.h + SI_PAD
    )
  }
  for (let col = 0, x = MATRIX_SPACING / 2; x < VW; x += MATRIX_SPACING, col++) {
    for (let row = 0, y = MATRIX_SPACING / 2; y < VH; y += MATRIX_SPACING, row++) {
      if (inGrain(x, y)) continue
      if ((col + row) % 2 === 0) {
        if (row % 2 === 0) ions.push({ type: 'Ca', x, y, r: 5.5 })
        // odd-row Ca deleted — each O then has exactly 2 Ca orthogonal neighbors
      } else {
        ions.push({ type: 'O', x, y, r: 3 })
      }
    }
  }
  // Drop O atoms with no Ca orthogonal neighbor — happens when grain gaps are
  // too narrow to fit a Ca row, leaving orphaned O between two sand surfaces.
  return ions.filter(ion =>
    ion.type !== 'O' ||
    ions.some(other => other.type === 'Ca' && Math.hypot(other.x - ion.x, other.y - ion.y) <= NEAR_BOND)
  )
}

// Fast integer hash → [0, 1) for per-particle phase-2 jitter.
function p2Hash(i) {
  let x = (i * 2654435761) >>> 0
  x = (Math.imul(x ^ (x >>> 16), 0x45d9f3b)) >>> 0
  return (x ^ (x >>> 16)) / 0x100000000
}

// ── Phase 2 displacement precomputation ───────────────────────
// Annotates each cement particle with:
//   p2frac  – fraction along the total crack path when the crack reaches this atom
//   p2disp  – rightward displacement (SVG units) once activated
//
// Vertical segments: cement atoms within 1.5 × MATRIX_SPACING to the LEFT of the
//   crack line slide RIGHT by 2 × MATRIX_SPACING, row by row as crack progresses.
// Horizontal rightward segments (crack sliding along grain top): cement atoms
//   within 1.5 × MATRIX_SPACING above/below the segment and within its x-span
//   slide RIGHT by 2 × MATRIX_SPACING, left-to-right as crack traverses the grain.
export function buildPhase2Disps(particles, crackWaypoints, p2DispScale = 1) {
  const n = particles.length
  const p2frac = new Float32Array(n).fill(2)   // >1 = never activates
  const p2disp = new Float32Array(n)

  if (!crackWaypoints || crackWaypoints.length < 2) return { p2frac, p2disp }

  // Precompute cumulative path fractions for each segment
  let total = 0
  const segs = []
  for (let k = 0; k < crackWaypoints.length - 1; k++) {
    const a = crackWaypoints[k], b = crackWaypoints[k + 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    segs.push({ a, b, len })
    total += len
  }
  let cum = 0
  for (const s of segs) {
    s.f0 = cum / total
    cum += s.len
    s.f1 = cum / total
    s.isVert = Math.abs(s.b.x - s.a.x) < 1
    s.goesRight = s.b.x > s.a.x
  }

  const THRESH = MATRIX_SPACING * 1.5   // proximity window for horizontal segments

  for (let i = 0; i < n; i++) {
    const p = particles[i]
    if (p.isGrain) continue

    for (const s of segs) {
      const sdx = s.b.x - s.a.x
      const sdy = s.b.y - s.a.y
      if (sdy > 0 && Math.abs(sdy) >= Math.abs(sdx)) {
        // Vertical or mostly-vertical segment — covers both straight and jittered segments.
        // Interpolate the crack's x at this atom's y so rows shift as unified chunks.
        const yLo = s.a.y, yHi = s.b.y
        if (p.y0 < yLo - 0.5 || p.y0 > yHi + 0.5) continue
        const yFrac = (p.y0 - yLo) / (yHi - yLo)
        const crackX = s.a.x + (s.b.x - s.a.x) * yFrac
        const base = (s.f0 + yFrac * (s.f1 - s.f0)) * (1 - P2_SNAP_RAMP - P2_JITTER * 0.5)
        const frac = Math.max(0, Math.min(1 - P2_SNAP_RAMP, base + (p2Hash(i) - 0.5) * P2_JITTER))
        if (p.x0 >= crackX - FAULT_CORRIDOR) {
          // Right block — snap right
          p2frac[i] = frac
          p2disp[i] = 2 * MATRIX_SPACING * p2DispScale
          break
        }
      } else if (s.goesRight) {
        // Horizontal segment along grain top — stagger atoms by x so the band
        // ripples across rather than snapping all at once.
        const crackY = s.a.y
        const xLo = Math.min(s.a.x, s.b.x)
        const xHi = Math.max(s.a.x, s.b.x)
        if (Math.abs(p.y0 - crackY) <= THRESH &&
            p.x0 >= xLo - 0.5 && p.x0 <= xHi + 0.5) {
          const base = s.f0 * (1 - P2_SNAP_RAMP - P2_JITTER * 0.5)
          p2frac[i] = Math.max(0, Math.min(1 - P2_SNAP_RAMP, base + (p2Hash(i) - 0.5) * P2_JITTER))
          p2disp[i] = 2 * MATRIX_SPACING * p2DispScale
          break
        }
      }
    }
  }
  // Grain atoms — whole grain moves together if its centroid is inside the right-side block
  const grainGroups = new Map()
  for (let i = 0; i < n; i++) {
    const p = particles[i]
    if (!p.isGrain) continue
    if (!grainGroups.has(p.grainIdx)) grainGroups.set(p.grainIdx, { indices: [], cx: 0, cy: 0 })
    const g = grainGroups.get(p.grainIdx)
    g.indices.push(i)
    g.cx += p.x0
    g.cy += p.y0
  }
  for (const g of grainGroups.values()) { g.cx /= g.indices.length; g.cy /= g.indices.length }

  for (const [gKey, g] of grainGroups.entries()) {
    for (const s of segs) {
      const sdx = s.b.x - s.a.x
      const sdy = s.b.y - s.a.y
      if (!(sdy > 0 && Math.abs(sdy) >= Math.abs(sdx))) continue
      const yLo = s.a.y, yHi = s.b.y
      if (g.cy < yLo - 0.5 || g.cy > yHi + 0.5) continue
      const yFrac = (g.cy - yLo) / (yHi - yLo)
      const crackXg = s.a.x + (s.b.x - s.a.x) * yFrac
      const baseG = (s.f0 + yFrac * (s.f1 - s.f0)) * (1 - P2_SNAP_RAMP - P2_JITTER * 0.5)
      const fracG = Math.max(0, Math.min(1 - P2_SNAP_RAMP, baseG + (p2Hash(gKey * 997 + 1) - 0.5) * P2_JITTER))
      if (g.cx >= crackXg - FAULT_CORRIDOR) {
        for (const i of g.indices) { p2frac[i] = fracG; p2disp[i] = 2 * MATRIX_SPACING * p2DispScale }
        break
      }
    }
  }

  return { p2frac, p2disp }
}

// ── Physics engine ─────────────────────────────────────────────
export function buildPhysics(ions, grains, lattices, p2DispScale = 1, noDiag = false, crackWaypointsOverride = null) {
  // Build particle list: matrix ions first, then grain atoms
  const particles = []

  ions.forEach(ion => {
    particles.push({
      x0: ion.x, y0: ion.y, x: ion.x, y: ion.y,
      vx: 0, vy: 0,
      isGrain: false, grainIdx: -1,
      type: ion.type, r: ion.r,
    })
  })
  const matrixCount = particles.length

  lattices.forEach((lat, gi) => {
    lat.forEach(node => {
      particles.push({
        x0: node.x, y0: node.y, x: node.x, y: node.y,
        vx: 0, vy: 0,
        isGrain: true, grainIdx: gi,
        type: node.type, r: node.type === 'Si' ? 4 : 3,
      })
    })
  })

  const n = particles.length

  // Build bonds
  const bonds = []
  for (let i = 0; i < n; i++) {
    const pi = particles[i]
    for (let j = i + 1; j < n; j++) {
      const pj = particles[j]
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d = Math.hypot(dx, dy)

      let bondType = null
      if (!pi.isGrain && !pj.isGrain) {
        if (d <= NEAR_BOND) bondType = 'cc-near'
      } else if (pi.isGrain && pj.isGrain && pi.grainIdx === pj.grainIdx) {
        if (d <= GRAIN_BOND && (pi.type === 'Si') !== (pj.type === 'Si')) bondType = 'ss'
      } else if (pi.isGrain !== pj.isGrain) {
        if (d <= IFACE_BOND) bondType = 'cs'
      }
      if (!bondType) continue

      const diagonal = Math.abs(dx) > 2 && Math.abs(dy) > 2
      if (noDiag && diagonal) continue
      bonds.push({
        i, j,
        restLen: d,
        k:           BOND_K[bondType],
        breakStrain: BOND_BREAK[bondType],
        strain: 0,
        broken: false,
        type: bondType,
        isFault: false,   // applied in second pass after crack path is known
        diagonal,
      })
    }
  }

  // Stamp each bond with inCrop, fieldAlpha, edgeProtected
  const CROP_X0 = (VW - VH) / 2
  const CROP_X1 = (VW + VH) / 2
  for (const b of bonds) {
    const pi = particles[b.i], pj = particles[b.j]
    b.inCrop = pi.x0 >= CROP_X0 && pi.x0 <= CROP_X1 && pj.x0 >= CROP_X0 && pj.x0 <= CROP_X1
    b.fieldAlpha = bondDistAlpha(b.restLen)
    const atEdge = pi.x0 <= CROP_X0 || pi.x0 >= CROP_X1 || pj.x0 <= CROP_X0 || pj.x0 >= CROP_X1
    if (atEdge) { b.breakStrain = Infinity; b.edgeProtected = true }
  }

  // Compute crack path from actual cs bond positions (or use provided override for blue panel)
  const crackWaypoints = crackWaypointsOverride ?? computeCrackPath(bonds, particles)

  // Second pass: apply fault pre-weakening now that the crack path is known
  for (const b of bonds) {
    if (b.edgeProtected || b.type === 'ss') continue
    const pi = particles[b.i], pj = particles[b.j]
    const midBx = (pi.x0 + pj.x0) / 2
    const midBy = (pi.y0 + pj.y0) / 2
    if (distToPath(midBx, midBy, crackWaypoints) < FAULT_CORRIDOR) {
      b.k           = BOND_K[b.type]    * FAULT_K_FACTOR
      b.breakStrain = BOND_BREAK[b.type] * FAULT_BREAK_FACTOR
      b.isFault = true
    }
  }

  // Pre-allocate force buffers
  const fx = new Float32Array(n)
  const fy = new Float32Array(n)

  // Grain metadata needed by stepPhysics for both grain-mode implementations
  const grainParticles = Array.from({ length: lattices.length }, () => [])
  for (let i = matrixCount; i < n; i++) grainParticles[particles[i].grainIdx].push(i)

  const grainCentroids = grains.map(g => ({ x0: g.x + g.w / 2, y0: g.y + g.h / 2 }))

  const grainCsBonds = Array.from({ length: lattices.length }, () => [])
  bonds.forEach((bond, bi) => {
    if (bond.type !== 'cs') return
    const gi = particles[bond.i].isGrain ? particles[bond.i].grainIdx : particles[bond.j].grainIdx
    grainCsBonds[gi].push(bi)
  })

  const { p2frac, p2disp } = buildPhase2Disps(particles, crackWaypoints, p2DispScale)

  return { particles, bonds, n, matrixCount, fx, fy, currentDisp: 0, grains, grainParticles, grainCentroids, grainCsBonds, p2frac, p2disp, crackWaypoints }
}

export function stepPhysics(phys, forceVal, speed = 1, canBreak = true) {
  const { particles, bonds, n } = phys

  const targetDisp = forceVal * MAX_PUNCH_DISP
  const gap = targetDisp - phys.currentDisp
  const totalRamp = Math.sign(gap) * Math.min(PUNCH_RAMP * speed, Math.abs(gap))
  const rampPerSub = totalRamp / SUBSTEPS

  for (let sub = 0; sub < SUBSTEPS; sub++) {
    phys.currentDisp += rampPerSub

    // Kinematic baseline: each atom displaced by field at its rest position.
    for (let i = 0; i < n; i++) {
      const p = particles[i]
      p.x = p.x0 + phys.currentDisp * (p.x0 / VW) * Math.max(0, 1.0 - p.y0 / VH)
    }

    // Bond strains and fracture (based on kinematic positions)
    for (let b = 0; b < bonds.length; b++) {
      const bond = bonds[b]
      if (bond.broken) continue
      const pi = particles[bond.i], pj = particles[bond.j]
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d = Math.hypot(dx, dy)
      if (d < 0.001) continue
      bond.strain = (d - bond.restLen) / bond.restLen
      if (canBreak && Math.abs(bond.strain) > bond.breakStrain) bond.broken = true
    }
  }

  // Spring relaxation: let particles settle under bond forces given the broken topology.
  // Boundary rows (top=driven, bottom=support) stay fixed at their kinematic positions.
  // Interior particles find equilibrium — bonds adjacent to breaks snap back visibly.
  relaxPhysics(phys, 60)

  // Second break pass on relaxed positions. cs (interface) bonds have near-zero
  // kinematic strain because grain atoms and adjacent matrix particles share nearly
  // identical x0, so the kinematic field moves them by the same amount. Their actual
  // stress only appears after PBD lets the grain and matrix deform relative to each other.
  if (canBreak) {
    for (let b = 0; b < bonds.length; b++) {
      const bond = bonds[b]
      if (bond.broken) continue
      if (Math.abs(bond.strain) > bond.breakStrain) bond.broken = true
    }
  }

  return 0
}

// Spring-back step: set punch to targetDisp (time-controlled by caller), apply kinematic
// ONLY to boundary rows, then relax interior particles from their current positions.
// Interior particles are never reset to the global kinematic baseline — they find their
// true new equilibrium through bond forces given the broken topology.
export function stepPhysicsP2(phys, targetDisp) {
  phys.currentDisp = targetDisp
  const { particles } = phys
  for (let i = 0; i < phys.n; i++) {
    const p = particles[i]
    if (p.y0 < MATRIX_SPACING || p.y0 > VH - MATRIX_SPACING) {
      p.x = p.x0 + phys.currentDisp * (p.x0 / VW) * Math.max(0, 1.0 - p.y0 / VH)
    }
  }
  relaxPhysics(phys, 60)
}

// Position-Based Dynamics relaxation: iteratively project each non-broken bond
// toward its rest length. Boundary particles are held fixed.
function relaxPhysics(phys, iters) {
  const { particles, bonds } = phys
  // Top row driven by punch; bottom row on support — both stay at kinematic positions.
  const fixed = p => p.y0 < MATRIX_SPACING || p.y0 > VH - MATRIX_SPACING

  for (let iter = 0; iter < iters; iter++) {
    for (let b = 0; b < bonds.length; b++) {
      const bond = bonds[b]
      if (bond.broken) continue
      const pi = particles[bond.i], pj = particles[bond.j]
      const fi = fixed(pi), fj = fixed(pj)
      if (fi && fj) continue
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d = Math.hypot(dx, dy)
      if (d < 0.001) continue
      // Fractional correction along bond axis
      const corr = (d - bond.restLen) / d
      const wi = fi ? 0 : 1, wj = fj ? 0 : 1
      const total = wi + wj
      pi.x += (wi / total) * corr * dx
      pi.y += (wi / total) * corr * dy
      pj.x -= (wj / total) * corr * dx
      pj.y -= (wj / total) * corr * dy
    }
  }

  // Recompute strains from relaxed positions for rendering and recording
  for (let b = 0; b < bonds.length; b++) {
    const bond = bonds[b]
    if (bond.broken) continue
    const pi = particles[bond.i], pj = particles[bond.j]
    const d = Math.hypot(pj.x - pi.x, pj.y - pi.y)
    if (d > 0.001) bond.strain = (d - bond.restLen) / bond.restLen
  }
}

// Seeded per-particle thermal jitter for canvas drawing.
// Three superimposed sinusoids per axis with fully independent params.
// Base frequencies are irrational-ratio so they never beat into a visible pattern.
function canvasJitter(idx, t) {
  function h(n) {
    let v = (n ^ 0xdeadbeef) | 0
    v = (((v >> 16) ^ v) * 0x45d9f3b) | 0
    v = (((v >> 16) ^ v) * 0x45d9f3b) | 0
    return ((v >> 16) ^ v) | 0
  }
  // stride 97 (prime) separates adjacent particle indices so they get unrelated hashes
  const u = s => ((h(idx * 97 + s) >>> 0) & 0xFF) / 255

  const TAU = Math.PI * 2
  const jx =
    (0.05 + u(0)  * 0.15) * Math.sin(TAU * (( 3.7 + u(1)  * 4.1) * t + u(2))) +
    (0.03 + u(3)  * 0.09) * Math.sin(TAU * (( 7.3 + u(4)  * 2.9) * t + u(5))) +
    (0.015 + u(6) * 0.045) * Math.sin(TAU * ((13.1 + u(7)  * 1.7) * t + u(8)))
  const jy =
    (0.05 + u(9)  * 0.15) * Math.sin(TAU * (( 4.3 + u(10) * 3.7) * t + u(11))) +
    (0.03 + u(12) * 0.09) * Math.sin(TAU * (( 8.1 + u(13) * 2.3) * t + u(14))) +
    (0.015 + u(15) * 0.045) * Math.sin(TAU * ((11.7 + u(16) * 1.9) * t + u(17)))
  return { jx, jy }
}

// ── Scrub recording helpers ────────────────────────────────────
export function snapshotP1(phys, crackFraction, ts) {
  const { particles, bonds } = phys
  const n = particles.length, m = bonds.length
  const px = new Float32Array(n), py = new Float32Array(n)
  const bs = new Float32Array(m), bb = new Uint8Array(m)
  for (let i = 0; i < n; i++) { px[i] = particles[i].x; py[i] = particles[i].y }
  for (let j = 0; j < m; j++) { bs[j] = bonds[j].strain; bb[j] = bonds[j].broken ? 1 : 0 }
  return { type: 'p1', px, py, bs, bb, cf: crackFraction, ts }
}

function applyP1Snapshot(phys, snap) {
  const { particles, bonds } = phys
  for (let i = 0; i < particles.length; i++) { particles[i].x = snap.px[i]; particles[i].y = snap.py[i] }
  for (let j = 0; j < bonds.length; j++) { bonds[j].strain = snap.bs[j]; bonds[j].broken = snap.bb[j] === 1 }
}

// Draws a lens/spindle bond shape in world coordinates — always tapers to points
// at both ends regardless of bondRound, so it never looks like a circle.
function fillLens(ctx, ax, ay, bx, by, bondRound) {
  const len = Math.hypot(bx - ax, by - ay)
  ctx.beginPath()   // always reset path so caller's fill/stroke is a no-op on degenerate bonds
  if (len < 0.5) return
  const ux = (bx - ax) / len, uy = (by - ay) / len  // along bond
  const px = -uy, py = ux                             // perpendicular
  const mx = (ax + bx) / 2, my = (ay + by) / 2
  const halfL = len * 0.40
  const r  = Math.min(bondRound, halfL * 0.65)  // cap prevents circular look
  const cp = halfL * 0.45                        // control-point offset — governs tip sharpness
  ctx.beginPath()
  ctx.moveTo(mx - halfL * ux, my - halfL * uy)
  ctx.bezierCurveTo(
    mx - cp * ux + r * px, my - cp * uy + r * py,
    mx + cp * ux + r * px, my + cp * uy + r * py,
    mx + halfL * ux, my + halfL * uy,
  )
  ctx.bezierCurveTo(
    mx + cp * ux - r * px, my + cp * uy - r * py,
    mx - cp * ux - r * px, my - cp * uy - r * py,
    mx - halfL * ux, my - halfL * uy,
  )
  ctx.closePath()
}

// ── Force data for selected particle ──────────────────────────

// Charge values: Ca=+2, Si=+0.5, grain O=-0.5, cement O (OH)=-1
function particleCharge(p) {
  if (p.type === 'Ca') return 2
  if (p.type === 'Si') return 0.5
  return p.isGrain ? -0.5 : -1
}
const CHARGE_POS = '62,127,214'   // cool blue  — positive (δ+, 2+)
const CHARGE_NEG = '231,131,42'   // warm orange — negative (δ−, −)

// Alpha ramp: full at rest-length ≤ 110% of MATRIX_SPACING, fades to 0 by 170%
function bondDistAlpha(restLen) {
  const lo = MATRIX_SPACING * 1.1
  const hi = MATRIX_SPACING * 1.7
  if (restLen <= lo) return 1
  if (restLen >= hi) return 0
  const t = (restLen - lo) / (hi - lo)
  return Math.pow(1 - t, 3)   // cubic: near-zero by √2 spacing (~t=0.52)
}

// Reusable offscreen canvas for field blur batching (one blur composite per frame)
const fieldLayerCache = new WeakMap()
function getFieldLayer(canvas) {
  let layer = fieldLayerCache.get(canvas)
  if (!layer || layer.width !== canvas.width || layer.height !== canvas.height) {
    layer = document.createElement('canvas')
    layer.width  = canvas.width
    layer.height = canvas.height
    fieldLayerCache.set(canvas, layer)
  }
  return layer
}

// ── Canvas scene rendering (atoms + bonds at physics positions) ──
function drawScene(canvas, phys, crackFraction, crackWaypoints, ts = 0, showDiag = false, visualScale = VISUAL_SCALE, bondRound = 1.6, showField = true, showCharge = false, darkMode = true) {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const W   = canvas.clientWidth
  const H   = canvas.clientHeight
  if (!W || !H) return

  const cw = Math.round(W * dpr)
  const ch = Math.round(H * dpr)
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width  = cw
    canvas.height = ch
  }

  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, cw, ch)

  const scale   = (H / VH) * dpr
  const offsetX = (W * dpr - VW * scale) / 2
  const offsetY = 0
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY)

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, VW, VH)
  ctx.clip()

  ctx.fillStyle = darkMode ? C.bg : '#ede8df'
  ctx.fillRect(0, 0, VW, VH)

  const { particles, bonds, matrixCount } = phys

  const t = ts / 1000

  // Visual position: amplify displacement from rest for educational clarity
  const vx = p => p.x0 + (p.x - p.x0) * visualScale
  const vy = p => p.y0 + (p.y - p.y0) * visualScale

  // ── Bonds: draw field lenses to offscreen layer, composite with one blur ──
  if (showField) {
    const layer = getFieldLayer(canvas)
    const lctx  = layer.getContext('2d')
    lctx.clearRect(0, 0, layer.width, layer.height)
    const { a, b: mb, c, d, e, f } = ctx.getTransform()
    lctx.setTransform(a, mb, c, d, e, f)
    for (let b = 0; b < bonds.length; b++) {
      const bond = bonds[b]
      if (bond.broken) continue
      if (!showDiag && bond.diagonal) continue
      if (bond.fieldAlpha <= 0) continue
      lctx.globalAlpha = (darkMode ? 0.82 : 0.60) * bond.fieldAlpha
      const pi = particles[bond.i], pj = particles[bond.j]
      lctx.fillStyle = strainColor(bond.strain, bond.breakStrain, darkMode)
      fillLens(lctx, vx(pi), vy(pi), vx(pj), vy(pj), bondRound)
      lctx.fill()
    }
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.filter = 'blur(3px)'
    ctx.globalAlpha = 1
    ctx.drawImage(layer, 0, 0)
    ctx.filter = 'none'
    ctx.restore()
  }

  // ── All atoms at amplified physics positions + thermal jitter ──
  const atomStroke = darkMode ? 'rgba(255,255,255,0.50)' : 'rgba(0,0,0,0.22)'
  ctx.lineWidth = 0.5
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]
    const { jx, jy } = canvasJitter(i, t)
    const px = vx(p) + jx, py = vy(p) + jy
    ctx.beginPath()
    ctx.arc(px, py, p.r, 0, Math.PI * 2)
    ctx.fillStyle = p.type === 'Ca' ? C.Ca : p.type === 'Si' ? C.Si : C.O
    ctx.fill()
    ctx.strokeStyle = atomStroke
    ctx.stroke()
    if (p.type === 'O' && !p.isGrain) {
      ctx.beginPath()
      ctx.arc(px + 2.5, py - 2.5, 1.5, 0, Math.PI * 2)
      ctx.fillStyle = 'white'
      ctx.fill()
    }
    if (showCharge) {
      const q = particleCharge(p)
      const rgb = q > 0 ? CHARGE_POS : CHARGE_NEG
      const alpha = 0.52 + (Math.abs(q) / 2) * 0.38
      const cr = 8
      const grad = ctx.createRadialGradient(px, py, 0, px, py, cr)
      grad.addColorStop(0, `rgba(${rgb},${alpha.toFixed(3)})`)
      grad.addColorStop(1, `rgba(${rgb},0)`)
      ctx.beginPath()
      ctx.arc(px, py, cr, 0, Math.PI * 2)
      ctx.fillStyle = grad
      ctx.fill()
    }
  }

  // ── Bond strain labels (×1000, computed live from actual positions) ──
  ctx.font = '3.5px system-ui'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let b = 0; b < bonds.length; b++) {
    const bond = bonds[b]
    if (bond.broken) continue
    if (!showDiag && bond.diagonal) continue
    const pi = particles[bond.i], pj = particles[bond.j]
    const mx = (vx(pi) + vx(pj)) / 2
    const my = (vy(pi) + vy(pj)) / 2
    const actualDist = Math.hypot(pj.x - pi.x, pj.y - pi.y)
    const strain = (actualDist - bond.restLen) / bond.restLen
    const label = String(Math.round(Math.abs(strain) * 1000))
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillText(label, mx, my)
  }

  // ── Progressive crack path (draws top→bottom as fault bonds break) ──
  if (crackFraction > 0.01 && crackWaypoints?.length > 1) {
    const totalLen = crackWaypoints.reduce((sum, pt, i) =>
      i === 0 ? 0 : sum + Math.hypot(pt.x - crackWaypoints[i-1].x, pt.y - crackWaypoints[i-1].y), 0)
    const target = crackFraction * totalLen

    ctx.strokeStyle = 'rgba(25, 15, 15, 0.80)'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(crackWaypoints[0].x, crackWaypoints[0].y)
    let drawn = 0
    for (let i = 1; i < crackWaypoints.length; i++) {
      const segLen = Math.hypot(
        crackWaypoints[i].x - crackWaypoints[i-1].x,
        crackWaypoints[i].y - crackWaypoints[i-1].y
      )
      if (drawn + segLen >= target) {
        const t = (target - drawn) / segLen
        ctx.lineTo(
          crackWaypoints[i-1].x + t * (crackWaypoints[i].x - crackWaypoints[i-1].x),
          crackWaypoints[i-1].y + t * (crackWaypoints[i].y - crackWaypoints[i-1].y)
        )
        break
      }
      ctx.lineTo(crackWaypoints[i].x, crackWaypoints[i].y)
      drawn += segLen
    }
    ctx.stroke()
  }

  ctx.restore()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

// ── Phase 2 scene: row-by-row crack-opening displacement ──────
// Atoms adjacent to the crack path are displaced rightward as p2Progress
// sweeps from 0→1 top-to-bottom. p2Progress is driven by crackFraction.
const HANG_MS = 260

function drawPhase2Scene(canvas, phys, p2Progress, ts, showDiag, bondRound = 1.6, hangStart = null, showField = true, crackWaypoints = null, shake = true, showCharge = false, darkMode = true) {
  if (!canvas || !phys) return
  const dpr = window.devicePixelRatio || 1
  const W = canvas.clientWidth
  const H = canvas.clientHeight
  if (!W || !H) return
  const cw = Math.round(W * dpr), ch = Math.round(H * dpr)
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch }

  const ctx = canvas.getContext('2d')
  // Clear to transparent so the dark panel background shows outside the red border
  ctx.clearRect(0, 0, cw, ch)

  const scale   = (H / VH) * dpr
  const offsetX = (W * dpr - VW * scale) / 2
  const offsetY = 0
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY)

  // Clip to the viewbox so atoms shifted beyond the right edge stay hidden
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, VW, VH)
  ctx.clip()

  ctx.fillStyle = darkMode ? C.bg : '#ede8df'
  ctx.fillRect(0, 0, VW, VH)

  // Seismic shake — strongest at crack initiation, done by p2Progress = 0.5
  const shakeAmp = shake ? Math.max(0, 1 - p2Progress * 2) * 0.69 : 0
  ctx.translate(
    shakeAmp * (Math.sin(ts * 0.053 + 1.7) * 0.65 + Math.sin(ts * 0.089 + 0.4) * 0.35),
    shakeAmp * 0.45 * Math.sin(ts * 0.047 + 2.3),
  )

  const { particles, bonds, matrixCount, p2frac, p2disp, grains, grainParticles } = phys
  const t = ts / 1000

  // Cubic ease-out: fast whip in, smooth settle. Many rows animate simultaneously
  // because P2_SNAP_RAMP is wide — gives a continuous wave rather than discrete steps.
  const xs = new Float32Array(particles.length)
  for (let i = 0; i < particles.length; i++) {
    const frac = p2frac[i]
    if (frac >= 2) { xs[i] = particles[i].x0; continue }
    const raw = Math.max(0, Math.min(1, (p2Progress - frac) / P2_SNAP_RAMP))
    const eased = 1 - Math.pow(1 - raw, 3)   // cubic ease-out
    xs[i] = particles[i].x0 + p2disp[i] * eased
  }


  // ── Bonds ── (skip bonds that span the crack — one end shifted, other not)
  if (showField) {
    const layer = getFieldLayer(canvas)
    const lctx  = layer.getContext('2d')
    lctx.clearRect(0, 0, layer.width, layer.height)
    const { a, b: mb, c, d, e, f } = ctx.getTransform()
    lctx.setTransform(a, mb, c, d, e, f)
    for (let b = 0; b < bonds.length; b++) {
      const bond = bonds[b]
      if (!showDiag && bond.diagonal) continue
      const ax = xs[bond.i], ay = particles[bond.i].y0
      const bx = xs[bond.j], by = particles[bond.j].y0
      // iShifted: right-block particle that has snapped (xs moved rightward from x0)
      const iShifted = xs[bond.i] > particles[bond.i].x0 + 0.01
      const jShifted = xs[bond.j] > particles[bond.j].x0 + 0.01
      if (iShifted !== jShifted) {
        // Bond spans the crack — fade out as particles separate
        const curLen = Math.hypot(bx - ax, by - ay)
        const stretch = Math.max(0, curLen - bond.restLen) / bond.restLen
        const alpha = Math.max(0, 1 - stretch * 2)
        if (alpha > 0) {
          lctx.globalAlpha = alpha * (darkMode ? 0.85 : 0.65)
          lctx.fillStyle = strainColor(bond.strain, bond.breakStrain, darkMode)
          fillLens(lctx, ax, ay, bx, by, bondRound)
          lctx.fill()
        }
        continue
      }
      if (bond.fieldAlpha <= 0) continue
      lctx.globalAlpha = (darkMode ? 0.82 : 0.60) * bond.fieldAlpha
      const actualLen = Math.hypot(bx - ax, by - ay)
      const actualStrain = (actualLen - bond.restLen) / bond.restLen
      lctx.fillStyle = strainColor(actualStrain, bond.breakStrain, darkMode)
      fillLens(lctx, ax, ay, bx, by, bondRound)
      lctx.fill()
    }
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.filter = 'blur(3px)'
    ctx.globalAlpha = 1
    ctx.drawImage(layer, 0, 0)
    ctx.filter = 'none'
    ctx.restore()
  }

  // ── Bright-blue hang: flash broken bonds at peak colour before they vanish ──
  if (showField && hangStart !== null) {
    const age = ts - hangStart
    if (age < HANG_MS) {
      const alpha = Math.max(0, 1 - age / HANG_MS) * 0.88
      ctx.globalAlpha = alpha
      for (let b = 0; b < bonds.length; b++) {
        const bond = bonds[b]
        if (!bond.broken) continue
        if (!showDiag && bond.diagonal) continue
        const ax = xs[bond.i], ay = particles[bond.i].y0
        const bx = xs[bond.j], by = particles[bond.j].y0
        ctx.fillStyle = 'rgb(0, 200, 255)'
        fillLens(ctx, ax, ay, bx, by, bondRound)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
  }

  // ── All atoms displaced + thermal jitter ──
  const atomStroke2 = darkMode ? 'rgba(255,255,255,0.50)' : 'rgba(0,0,0,0.22)'
  ctx.lineWidth = 0.5
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]
    const { jx, jy } = canvasJitter(i, t)
    const px = xs[i] + jx, py = p.y0 + jy
    ctx.beginPath()
    ctx.arc(px, py, p.r, 0, Math.PI * 2)
    ctx.fillStyle = p.type === 'Ca' ? C.Ca : p.type === 'Si' ? C.Si : C.O
    ctx.fill()
    ctx.strokeStyle = atomStroke2
    ctx.stroke()
    if (p.type === 'O' && !p.isGrain) {
      ctx.beginPath()
      ctx.arc(px + 2.5, py - 2.5, 1.5, 0, Math.PI * 2)
      ctx.fillStyle = 'white'
      ctx.fill()
    }
    if (showCharge) {
      const q = particleCharge(p)
      const rgb = q > 0 ? CHARGE_POS : CHARGE_NEG
      const alpha = 0.52 + (Math.abs(q) / 2) * 0.38
      const cr = 8
      const grad = ctx.createRadialGradient(px, py, 0, px, py, cr)
      grad.addColorStop(0, `rgba(${rgb},${alpha.toFixed(3)})`)
      grad.addColorStop(1, `rgba(${rgb},0)`)
      ctx.beginPath()
      ctx.arc(px, py, cr, 0, Math.PI * 2)
      ctx.fillStyle = grad
      ctx.fill()
    }
  }

  ctx.restore()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

// ── Per-particle jitter (thermal animation) ────────────────────
function jitterStyle(idx) {
  function h(n) {
    let v = (n ^ 0xdeadbeef) | 0
    v = (((v >> 16) ^ v) * 0x45d9f3b) | 0
    v = (((v >> 16) ^ v) * 0x45d9f3b) | 0
    return ((v >> 16) ^ v) | 0
  }
  const amp = (n) => ((h(idx * 11 + n) & 0xFF) / 127.5 - 1) * 0.7
  const dur = (0.18 + (h(idx * 11 + 8) & 0x1F) * 0.008).toFixed(3)
  const del = -((h(idx * 11 + 9) & 0xFF) * 0.004).toFixed(3)
  return {
    '--j1x': `${amp(0).toFixed(2)}px`, '--j1y': `${amp(1).toFixed(2)}px`,
    '--j2x': `${amp(2).toFixed(2)}px`, '--j2y': `${amp(3).toFixed(2)}px`,
    '--j3x': `${amp(4).toFixed(2)}px`, '--j3y': `${amp(5).toFixed(2)}px`,
    '--j4x': `${amp(6).toFixed(2)}px`, '--j4y': `${amp(7).toFixed(2)}px`,
    animation: `particle-jitter ${dur}s linear ${del}s infinite`,
  }
}

const C = {
  Si: '#d4a020', O: '#cc3a3a', Ca: '#706a6a',
  bg: '#111111', grain: '#d8cb98', stroke: '#a09050',
}

function LegendDot({ cx, cy, r, fill, label, showH = false }) {
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill={fill} />
      {showH && <circle cx={cx + 2.5} cy={cy - 2.5} r={1.5} fill="white" />}
      <text x={cx + r + 5} y={cy + 4} className="micro-legend">{label}</text>
    </>
  )
}

// ── Breakthrough detection ─────────────────────────────────────
// Divides the active zone into vertical strips and checks that every
// strip contains at least one broken fault bond. This is more robust
// than a BFS chain because horizontal routing sections (crack detouring
// around a grain top) don't break under vertical compression — but the
// vertical segments beside each grain do, so strip coverage still works.
function hasBreakthroughPath(bonds, particles) {
  const faultBroken = bonds.filter(b => b.isFault && b.broken)
  if (faultBroken.length === 0) return false

  const TOP_Y  = MATRIX_SPACING * 5          // 80 px — below punch rows
  const BOT_Y  = VH - MATRIX_SPACING * 4     // 286 px — above fixed base
  const STRIPS = 4
  const stripH = (BOT_Y - TOP_Y) / STRIPS

  const covered = new Array(STRIPS).fill(false)
  for (const b of faultBroken) {
    const midY = (particles[b.i].y0 + particles[b.j].y0) / 2
    if (midY < TOP_Y || midY > BOT_Y) continue
    const strip = Math.min(STRIPS - 1, Math.floor((midY - TOP_Y) / stripH))
    covered[strip] = true
  }
  return covered[0] && covered[1]
}


// ── BondIcon: canvas-rendered bond pair using exact same draw code as main view ──
export function BondIcon({ particles, bonds, scale = 1.5, darkMode = true, showCharge = false }) {
  const canvasRef = useRef(null)
  const PAD = 6  // must accommodate glow radius = p.r * 2
  // bounding box
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const p of particles) {
    x0 = Math.min(x0, p.x - p.r - PAD)
    x1 = Math.max(x1, p.x + p.r + PAD)
    y0 = Math.min(y0, p.y - p.r - PAD)
    y1 = Math.max(y1, p.y + p.r + PAD)
    if (p.type === 'O' && !p.isGrain) {
      x1 = Math.max(x1, p.x + 2.5 + 1.5 + PAD)
      y0 = Math.min(y0, p.y - 2.5 - 1.5 - PAD)
    }
  }
  const cssW = Math.round((x1 - x0) * scale)
  const cssH = Math.round((y1 - y0) * scale)
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const s = scale * dpr
    const tx = -x0 * s, ty = -y0 * s
    ctx.setTransform(s, 0, 0, s, tx, ty)
    // bonds on offscreen layer → blur → composite
    const layer = document.createElement('canvas')
    layer.width = canvas.width
    layer.height = canvas.height
    const lctx = layer.getContext('2d')
    lctx.setTransform(s, 0, 0, s, tx, ty)
    for (const bond of bonds) {
      const pa = particles[bond.i], pb = particles[bond.j]
      lctx.globalAlpha = darkMode ? 0.82 : 0.60
      lctx.fillStyle = strainColor(0, 1, darkMode)
      fillLens(lctx, pa.x, pa.y, pb.x, pb.y, 1.6)
      lctx.fill()
    }
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.filter = 'blur(3px)'
    ctx.drawImage(layer, 0, 0)
    ctx.filter = 'none'
    ctx.restore()
    ctx.setTransform(s, 0, 0, s, tx, ty)
    // particles — glow halo + solid fill + charge overlay, matching drawScene exactly
    const stroke = darkMode ? 'rgba(255,255,255,0.50)' : 'rgba(0,0,0,0.22)'
    const rgbOf = (p) => p.type === 'Ca' ? '112,106,106' : p.type === 'Si' ? '212,160,32' : '204,58,58'
    ctx.lineWidth = 0.5
    for (const p of particles) {
      // Glow halo (mimics blurred bond-lens bleed in the main view)
      const glowR = p.r * 2
      const glowAlpha = darkMode ? 0.55 : 0.38
      const glow = ctx.createRadialGradient(p.x, p.y, p.r * 0.3, p.x, p.y, glowR)
      glow.addColorStop(0, `rgba(${rgbOf(p)},${glowAlpha})`)
      glow.addColorStop(1, `rgba(${rgbOf(p)},0)`)
      ctx.beginPath()
      ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2)
      ctx.fillStyle = glow
      ctx.fill()
      // Solid particle
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fillStyle = p.type === 'Ca' ? C.Ca : p.type === 'Si' ? C.Si : C.O
      ctx.fill()
      ctx.strokeStyle = stroke
      ctx.stroke()
      if (p.type === 'O' && !p.isGrain) {
        ctx.beginPath()
        ctx.arc(p.x + 2.5, p.y - 2.5, 1.5, 0, Math.PI * 2)
        ctx.fillStyle = 'white'
        ctx.fill()
      }
      // Charge overlay — radial gradient, same as drawScene
      if (showCharge) {
        const q = p.type === 'Ca' ? 2 : p.type === 'Si' ? 0.5 : (p.isGrain ? -0.5 : -1)
        const rgb = q > 0 ? CHARGE_POS : CHARGE_NEG
        const alpha = 0.52 + (Math.abs(q) / 2) * 0.38
        const cr = p.r * 2
        const cGrad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, cr)
        cGrad.addColorStop(0, `rgba(${rgb},${alpha.toFixed(3)})`)
        cGrad.addColorStop(1, `rgba(${rgb},0)`)
        ctx.beginPath()
        ctx.arc(p.x, p.y, cr, 0, Math.PI * 2)
        ctx.fillStyle = cGrad
        ctx.fill()
      }
    }
  })
  return <canvas ref={canvasRef} style={{ display: 'block', width: cssW, height: cssH }} />
}

// ── MicroPanel component ───────────────────────────────────────
export default function MicroPanel({ sandPct, phase = 'idle', layoutSeed = 0, force = 0, speed = 1, showDiag = false, bondRound = 1.6, onSettled, onFailed, scrubT = null, onRecordingReady }) {
  const grains   = useMemo(() => buildGrains(sandPct, layoutSeed * 7919 + sandPct * 137 + 42), [sandPct, layoutSeed])
  const ions     = useMemo(() => buildIons(grains), [grains])
  const lattices = useMemo(() => grains.map(buildLattice), [grains])
  const [crackD, setCrackD] = useState('')

  const svgRef    = useRef(null)
  const canvasRef = useRef(null)
  const physRef   = useRef(null)
  const rafRef    = useRef(null)
  const forceRef     = useRef(force)
  const speedRef     = useRef(speed)
  const showDiagRef  = useRef(showDiag)
  const bondRoundRef = useRef(bondRound)
  const dispForceRef    = useRef(0)   // animated ramp: 0 → forceRef.current
  const stableRef       = useRef(0)   // consecutive stable frames
  const crackFractionRef = useRef(0)  // last computed crack fraction, read by draw-only loop
  const recordingRef    = useRef([])
  const finalSnapRef    = useRef(null)
  const scrubTRef       = useRef(scrubT)

  // Keep refs in sync with props (picked up inside RAF without restart)
  useEffect(() => { forceRef.current = force }, [force])
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { showDiagRef.current = showDiag }, [showDiag])
  useEffect(() => { bondRoundRef.current = bondRound }, [bondRound])
  useEffect(() => { scrubTRef.current = scrubT }, [scrubT])

  // Rebuild physics whenever layout changes
  useEffect(() => {
    const phys = buildPhysics(ions, grains, lattices)
    physRef.current = phys
    setCrackD(smoothPath(phys.crackWaypoints))
  }, [ions, grains, lattices])

  // RAF loop: run when testing, stop otherwise
  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)

    if (phase === 'idle') {
      const phys = buildPhysics(ions, grains, lattices)
      physRef.current = phys
      setCrackD(smoothPath(phys.crackWaypoints))
      stableRef.current = 0
      dispForceRef.current = 0
      crackFractionRef.current = 0
      recordingRef.current = []
      finalSnapRef.current = null
      function idleLoop(ts) {
        drawScene(canvasRef.current, physRef.current, 0, physRef.current?.crackWaypoints, ts, false, 0, bondRoundRef.current)
        rafRef.current = requestAnimationFrame(idleLoop)
      }
      rafRef.current = requestAnimationFrame(idleLoop)
      return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    }

    if (phase === 'settled' || phase === 'failed') {
      let prevSt = scrubTRef.current
      function drawLoop(ts) {
        const st = scrubTRef.current
        const rec = recordingRef.current
        // Restore final state when user releases scrub handle
        if (st === null && prevSt !== null && finalSnapRef.current) {
          applyP1Snapshot(physRef.current, finalSnapRef.current)
        }
        prevSt = st
        if (st !== null && rec.length > 0) {
          const snap = rec[Math.round(st * (rec.length - 1))]
          applyP1Snapshot(physRef.current, snap)
          drawScene(canvasRef.current, physRef.current, snap.cf, physRef.current?.crackWaypoints, ts, showDiagRef.current, VISUAL_SCALE, bondRoundRef.current)
        } else {
          drawScene(canvasRef.current, physRef.current, crackFractionRef.current, physRef.current?.crackWaypoints, ts, showDiagRef.current, VISUAL_SCALE, bondRoundRef.current)
        }
        rafRef.current = requestAnimationFrame(drawLoop)
      }
      rafRef.current = requestAnimationFrame(drawLoop)
      return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    }

    if (phase !== 'testing') return

    recordingRef.current = []
    finalSnapRef.current = null
    stableRef.current = 0
    dispForceRef.current = 0   // always ramp from zero so crack forms as animation
    let frameCount = 0
    let prevBroken = 0

    function frame(ts) {
      const phys = physRef.current
      if (!phys) return

      // Ramp displayed force from 0 toward slider value each frame
      dispForceRef.current = Math.min(forceRef.current, dispForceRef.current + FORCE_RAMP_RATE * speedRef.current)

      const canBreak = forceRef.current >= FRACTURE_THRESHOLD
      const maxV = stepPhysics(phys, dispForceRef.current, speedRef.current, canBreak)

      // Crack fraction: fraction of non-ss fault bonds broken → drives partial crack draw
      const faultBonds  = phys.bonds.filter(b => b.isFault && b.type !== 'ss')
      const faultBroken = faultBonds.filter(b => b.broken).length
      const crackFraction = faultBonds.length > 0 ? faultBroken / faultBonds.length : 0
      crackFractionRef.current = crackFraction

      drawScene(canvasRef.current, phys, crackFraction, phys.crackWaypoints, ts, showDiagRef.current, VISUAL_SCALE, bondRoundRef.current)
      frameCount++

      // Record every other frame
      if (frameCount % 2 === 0) recordingRef.current.push(snapshotP1(phys, crackFraction, ts))

      const brokenNow = phys.bonds.filter(b => b.broken).length
      const newBreaks  = brokenNow > prevBroken

      // Trigger failure (and sync macro crack) as soon as the first fault bond breaks
      if (canBreak && crackFraction > 0 && newBreaks) {
        const snap = snapshotP1(phys, crackFraction, ts)
        recordingRef.current.push(snap)
        finalSnapRef.current = snap
        onRecordingReady?.()
        onFailed?.(Math.round(dispForceRef.current * 2500))
        return
      }

      if (newBreaks || maxV > SETTLE_VEL) {
        stableRef.current = 0
      } else {
        stableRef.current++
      }
      prevBroken = brokenNow

      // Only settle after force has fully ramped AND system is stable
      const forceFullyRamped = dispForceRef.current >= forceRef.current - 0.001
      const atTarget = Math.abs(phys.currentDisp - dispForceRef.current * MAX_PUNCH_DISP) < 0.05
      if (frameCount > 30 && stableRef.current >= SETTLE_FRAMES && phys.currentDisp > 0.1 && atTarget && forceFullyRamped) {
        const snap = snapshotP1(phys, crackFraction, ts)
        recordingRef.current.push(snap)
        finalSnapRef.current = snap
        onRecordingReady?.()
        onSettled?.()
        return
      }

      rafRef.current = requestAnimationFrame(frame)
    }

    rafRef.current = requestAnimationFrame(frame)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [phase])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid meet"
        className="panel-svg"
      >
        <defs>
          <clipPath id="micro-clip">
            <rect width={VW} height={VH} rx={4} />
          </clipPath>
        </defs>

        <g clipPath="url(#micro-clip)">
          <rect width={VW} height={VH} fill={C.bg} rx={4} />

          {/* Matrix ions: shown at rest in idle; canvas draws them at physics positions during simulation */}
          {phase === 'idle' && ions.map((ion, i) => (
            <g key={i}>
              <circle
                cx={ion.x} cy={ion.y} r={ion.r}
                fill={ion.type === 'Ca' ? C.Ca : C.O}
                opacity={1}
                style={jitterStyle(i * 73 + 29)}
              />
              {ion.type === 'O' && (
                <circle cx={ion.x + 2.5} cy={ion.y - 2.5} r={1.5}
                  fill="white" opacity={1}
                  style={jitterStyle(i * 73 + 29)} />
              )}
            </g>
          ))}

          {/* Sand grains */}
          {grains.map((g, gi) => (
            <g key={g.id}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h}
                fill="none" stroke="none" rx={3} />
              {phase === 'idle' && lattices[gi].map((node, ni) => (
                <circle key={ni}
                  cx={node.x} cy={node.y}
                  r={node.type === 'Si' ? 4 : 3}
                  fill={node.type === 'Si' ? C.Si : C.O}
                  opacity={1}
                  style={jitterStyle((gi * 500 + ni) * 137 + 42)}
                />
              ))}
            </g>
          ))}

        </g>
      </svg>

      {/* Bond overlay canvas — drawn by physics RAF */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none',
        }}
      />

      {/* UI overlay: keys always on top of canvas; crack path when failed */}
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      >
        {/* Red border matching the macro rectangle's aspect ratio */}
        <rect x={3} y={3} width={VW - 6} height={VH - 6} fill="none" stroke="#cc2222" strokeWidth={6} />
        {phase === 'failed' && (
          <path
            d={crackD}
            stroke="#1a1a1a"
            strokeWidth={3}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength="1"
            className="micro-crack"
          />
        )}

        {/* Particle key */}
        <g transform={`translate(110, ${VH - 20})`}>
          <rect x={-4} y={-11} width={200} height={24} fill="white" stroke="#ccc" strokeWidth={0.5} rx={3} />
          <LegendDot cx={6}   cy={0} r={4} fill={C.Si} label="Si" />
          <LegendDot cx={46}  cy={0} r={3} fill={C.O}  label="O (grain)" />
          <LegendDot cx={115} cy={0} r={4} fill={C.Ca} label="Ca" />
          <LegendDot cx={162} cy={0} r={3} fill={C.O}  label="OH⁻" showH />
        </g>

        {/* Electric field color key */}
        <defs>
          <linearGradient id="field-grad" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%"   stopColor="rgb(200,196,188)" />
            <stop offset="20%"  stopColor="rgb(195,90,255)" />
            <stop offset="55%"  stopColor="rgb(240,30,225)" />
            <stop offset="100%" stopColor="rgb(255,70,185)" />
          </linearGradient>
        </defs>
        <g transform={`translate(${VW - 278}, ${VH - 43})`}>
          <rect x={-4} y={-27} width={174} height={63} fill="white" stroke="#ccc" strokeWidth={0.5} rx={3} />
          {/* Bond type row */}
          <rect x={0} y={-25} width={32} height={16} fill={C.bg} rx={2} />
          <ellipse cx={11} cy={-17} rx={12} ry={4} fill="rgb(200,196,188)" stroke="white" strokeWidth={1.8} />
          <text x={27} y={-13} className="micro-legend">IMF</text>
          <rect x={62} y={-25} width={40} height={16} fill={C.bg} rx={2} />
          <ellipse cx={73} cy={-17} rx={12} ry={4} fill="rgb(200,196,188)" stroke="#111" strokeWidth={1.0} />
          <text x={89} y={-13} className="micro-legend">Bond</text>
          {/* Electric field label */}
          <text x={0} y={5} style={{ fontSize: '16px', fill: '#888', fontFamily: 'system-ui,sans-serif' }}>Energy in fields:</text>
          {/* Electric field gradient + Low/High */}
          <rect x={0} y={10} width={166} height={10} fill="url(#field-grad)" />
          <text x={0} y={31} style={{ fontSize: '16px', fill: '#888', fontFamily: 'system-ui,sans-serif' }}>Low</text>
          <text x={166} y={31} style={{ fontSize: '16px', fill: '#888', fontFamily: 'system-ui,sans-serif' }} textAnchor="end">High</text>
        </g>
      </svg>
    </div>
  )
}

// ── View B: Phase 1 (bonds stress, atoms at rest) → Phase 2 (bonds break, atoms displace) ──
export function MicroPanelB({ sandPct, phase = 'idle', layoutSeed = 0, force = 0, speed = 1, showDiag = false, noDiag = false, bondRound = 1.6, crackWaypoints: crackWaypointsProp, grainOverride = null, accentColor = '#cc2222', label = null, onSettled, onFailed, onBreakStart, scrubT = null, onRecordingReady, p2DispScale = 1, showField = true, showCharge = false, onBondCounts, preloadedRecording = null, darkMode = true }) {
  const grains   = useMemo(
    () => grainOverride ?? buildGrains(sandPct, layoutSeed * 7919 + sandPct * 137 + 42),
    [sandPct, layoutSeed, grainOverride]
  )
  const ions     = useMemo(() => buildIons(grains), [grains])
  const lattices = useMemo(() => grains.map(buildLattice), [grains])
  const [crackD, setCrackD] = useState('')

  const canvasRef        = useRef(null)
  const physRef          = useRef(null)
  const rafRef           = useRef(null)
  const forceRef         = useRef(force)
  const speedRef         = useRef(speed)
  const showDiagRef      = useRef(showDiag)
  const bondRoundRef     = useRef(bondRound)
  const showFieldRef     = useRef(showField)
  const dispForceRef     = useRef(0)
  const stableRef        = useRef(0)
  const p2StartTimeRef      = useRef(null)
  const p2BreakDispRef      = useRef(0)      // phys.currentDisp captured at first bond break
  const p2ProgressRef       = useRef(0)
  const currentP2ProgressRef = useRef(0)   // always set to the p2Progress actually rendered this frame
  const b2phaseRef          = useRef('phase1')  // transitions to 'phase2' (animating), then 'done'
  const recordingRef     = useRef([])
  const finalSnapRef     = useRef(null)
  const lastP1SnapRef    = useRef(null)
  const scrubTRef        = useRef(scrubT)
  const p2DispScaleRef   = useRef(p2DispScale)

  const showChargeRef             = useRef(showCharge)
  const darkModeRef               = useRef(darkMode)
  const onBondCountsRef           = useRef(onBondCounts)
  const onBreakStartRef           = useRef(onBreakStart)
  const noDiagRef                 = useRef(noDiag)
  const preloadedRecordingRef     = useRef(preloadedRecording)

  useEffect(() => { forceRef.current = force }, [force])
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { showDiagRef.current = showDiag }, [showDiag])
  useEffect(() => { bondRoundRef.current = bondRound }, [bondRound])
  useEffect(() => { showFieldRef.current = showField }, [showField])
  useEffect(() => { scrubTRef.current = scrubT }, [scrubT])
  useEffect(() => { p2DispScaleRef.current = p2DispScale }, [p2DispScale])
  useEffect(() => { showChargeRef.current = showCharge }, [showCharge])
  useEffect(() => { darkModeRef.current = darkMode }, [darkMode])
  useEffect(() => { onBondCountsRef.current = onBondCounts }, [onBondCounts])
  useEffect(() => { onBreakStartRef.current = onBreakStart }, [onBreakStart])
  useEffect(() => { noDiagRef.current = noDiag }, [noDiag])
  useEffect(() => { preloadedRecordingRef.current = preloadedRecording }, [preloadedRecording])


  useEffect(() => {
    const phys = buildPhysics(ions, grains, lattices, p2DispScaleRef.current, noDiagRef.current, crackWaypointsProp ?? null)
    physRef.current = phys
    setCrackD(smoothPath(phys.crackWaypoints))
  }, [ions, grains, lattices, p2DispScale, noDiag, crackWaypointsProp])

  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)

    function emitBondCounts(phys) {
      if (!onBondCountsRef.current || !phys?.bonds) return
      let siO = 0, caOH = 0, caO = 0
      const inP2 = b2phaseRef.current === 'phase2'
      const p2Progress = inP2 ? currentP2ProgressRef.current : -1
      const { p2frac } = phys
      let siOH = 0
      const { particles } = phys
      for (const b of phys.bonds) {
        if (b.diagonal || !b.inCrop || b.edgeProtected) continue
        let severed = b.broken
        if (!severed && inP2) {
          const iMoved = p2frac[b.i] < 2 && p2Progress >= p2frac[b.i]
          const jMoved = p2frac[b.j] < 2 && p2Progress >= p2frac[b.j]
          if (iMoved !== jMoved) severed = true
        }
        if (severed) continue
        if (b.type === 'ss') siO++
        else if (b.type === 'cc-near') caOH++
        else if (b.type === 'cs') {
          const grainPt = particles[b.i].isGrain ? particles[b.i] : particles[b.j]
          if (grainPt.type === 'Si') siOH++
          else caO++
        }
      }
      onBondCountsRef.current({ siO, caOH, caO, siOH })
    }


    if (phase === 'idle') {
      const phys0 = buildPhysics(ions, grains, lattices, p2DispScaleRef.current, noDiagRef.current, crackWaypointsProp ?? null)
      physRef.current = phys0
      setCrackD(smoothPath(phys0.crackWaypoints))
      stableRef.current = 0
      dispForceRef.current = 0
      p2StartTimeRef.current = null
      p2ProgressRef.current  = 0
      b2phaseRef.current = 'phase1'
      recordingRef.current = []
      finalSnapRef.current = null
      lastP1SnapRef.current = null
      function idleLoop(ts) {
        drawScene(canvasRef.current, physRef.current, 0, physRef.current?.crackWaypoints, ts, false, 1.6, bondRoundRef.current, showFieldRef.current, showChargeRef.current, darkModeRef.current)
        emitBondCounts(physRef.current)
        rafRef.current = requestAnimationFrame(idleLoop)
      }
      rafRef.current = requestAnimationFrame(idleLoop)
      return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    }

    if (phase === 'settled' || phase === 'failed') {
      if (preloadedRecordingRef.current?.length) {
        recordingRef.current = preloadedRecordingRef.current
        b2phaseRef.current = 'phase2'
        const lastP1 = [...preloadedRecordingRef.current].reverse().find(s => s.type === 'p1')
        if (lastP1) lastP1SnapRef.current = lastP1
      }
      let prevSt = scrubTRef.current
      function drawLoop(ts) {
        const st = scrubTRef.current
        const rec = recordingRef.current
        const isP2 = b2phaseRef.current === 'phase2'
        // Restore break-point strains when user releases scrub handle during Phase 2
        if (st === null && prevSt !== null && isP2 && lastP1SnapRef.current) {
          applyP1Snapshot(physRef.current, lastP1SnapRef.current)
        }
        prevSt = st
        // Scrub mode: always for preloaded recordings (manual tab), or after live animation completes.
        const hasPreload = !!preloadedRecordingRef.current?.length
        if (st !== null && rec.length > 0 && (hasPreload || p2ProgressRef.current >= 1)) {
          const snap = rec[Math.round(st * (rec.length - 1))]
          if (snap.type === 'p2') {
            if (lastP1SnapRef.current) applyP1Snapshot(physRef.current, lastP1SnapRef.current)
            currentP2ProgressRef.current = snap.p2Progress
            drawPhase2Scene(canvasRef.current, physRef.current, snap.p2Progress, ts, showDiagRef.current, bondRoundRef.current, null, showFieldRef.current, physRef.current?.crackWaypoints, false, showChargeRef.current, darkModeRef.current)
          } else {
            applyP1Snapshot(physRef.current, snap)
            drawScene(canvasRef.current, physRef.current, 0, physRef.current?.crackWaypoints, ts, showDiagRef.current, 1.6, bondRoundRef.current, showFieldRef.current, showChargeRef.current, darkModeRef.current)
          }
        } else if (isP2) {
          const P2_DURATION = 833
          const p2Progress = p2StartTimeRef.current !== null
            ? Math.min(1, (ts - p2StartTimeRef.current) * speedRef.current / P2_DURATION)
            : p2ProgressRef.current
          p2ProgressRef.current = p2Progress
          currentP2ProgressRef.current = p2Progress
          drawPhase2Scene(canvasRef.current, physRef.current, p2Progress, ts, showDiagRef.current, bondRoundRef.current, p2StartTimeRef.current, showFieldRef.current, physRef.current?.crackWaypoints, true, showChargeRef.current, darkModeRef.current)
        } else {
          drawScene(canvasRef.current, physRef.current, 0, physRef.current?.crackWaypoints, ts, showDiagRef.current, 1.6, bondRoundRef.current, showFieldRef.current, false, darkModeRef.current)
        }
        emitBondCounts(physRef.current)
        rafRef.current = requestAnimationFrame(drawLoop)
      }
      rafRef.current = requestAnimationFrame(drawLoop)
      return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    }

    if (phase !== 'testing') return

    const P2_SNAP_COUNT = 40  // pre-generate snapshots for p2Progress 0 → 1

    recordingRef.current = []
    finalSnapRef.current = null
    lastP1SnapRef.current = null
    stableRef.current = 0
    dispForceRef.current = 0
    p2StartTimeRef.current = null
    p2BreakDispRef.current = 0
    p2ProgressRef.current = 0
    currentP2ProgressRef.current = 0
    b2phaseRef.current = 'phase1'
    let frameCount = 0
    let prevBroken = 0

    function frame(ts) {
      const phys = physRef.current
      if (!phys) return

      // ── Phase 1: ramp force toward target, run physics ───────────────────────
      dispForceRef.current = Math.min(forceRef.current, dispForceRef.current + FORCE_RAMP_RATE * speedRef.current)
      const canBreak = forceRef.current >= FRACTURE_THRESHOLD
      stepPhysics(phys, dispForceRef.current, speedRef.current, canBreak)

      const brokenNow = phys.bonds.filter(b => b.broken).length

      if (frameCount === 0) {
        const faultBonds = phys.bonds.filter(b => b.isFault)
        console.log('[MicroPanelB] fault bonds:', faultBonds.length, 'types:', [...new Set(faultBonds.map(b=>b.type))], 'min breakStrain:', Math.min(...faultBonds.map(b=>b.breakStrain)), 'canBreak:', canBreak)
      }
      if (frameCount % 30 === 0) {
        const faultBroken = phys.bonds.filter(b => b.isFault && b.broken).length
        const maxStrain = phys.bonds.filter(b=>b.isFault && !b.broken).reduce((m,b)=>Math.max(m,Math.abs(b.strain)),0)
        console.log(`[MicroPanelB] frame=${frameCount} dispForce=${dispForceRef.current.toFixed(3)} currentDisp=${phys.currentDisp.toFixed(2)} faultBroken=${faultBroken} maxFaultStrain=${maxStrain.toFixed(4)} brokenNow=${brokenNow}`)
      }

      // First break → hand off to drawPhase2Scene in the settled/failed drawLoop
      if (canBreak && b2phaseRef.current === 'phase1' && brokenNow > 0) {
        const p2Active = phys.p2frac ? phys.p2frac.filter(f => f < 2).length : -1
        console.log('[MicroPanelB] BREAK FIRED! frame=', frameCount, 'dispForce=', dispForceRef.current.toFixed(3), 'brokenNow=', brokenNow, 'p2Active=', p2Active, 'p2disp[0]=', phys.p2disp?.[0]?.toFixed(4))
        b2phaseRef.current = 'phase2'
        p2StartTimeRef.current = ts
        const snap = snapshotP1(phys, 0, ts)
        recordingRef.current.push(snap)
        finalSnapRef.current = snap
        lastP1SnapRef.current = snap
        for (let i = 0; i <= P2_SNAP_COUNT; i++) {
          recordingRef.current.push({ type: 'p2', p2Progress: i / P2_SNAP_COUNT })
        }
        const p2Frac = (recordingRef.current.length - 1 - P2_SNAP_COUNT) / (recordingRef.current.length - 1)
        onBreakStartRef.current?.()
        onRecordingReady?.(p2Frac)
        onFailed?.(Math.round(dispForceRef.current * 2500))
        return
      }

      drawScene(canvasRef.current, phys, 0, phys.crackWaypoints, ts, showDiagRef.current, 1.6, bondRoundRef.current, showFieldRef.current, showChargeRef.current, darkModeRef.current)
      emitBondCounts(phys)
      frameCount++

      if (frameCount % 2 === 0) recordingRef.current.push(snapshotP1(phys, 0, ts))

      const newBreaks = brokenNow > prevBroken
      if (newBreaks) stableRef.current = 0
      else stableRef.current++
      prevBroken = brokenNow

      const forceFullyRamped = dispForceRef.current >= forceRef.current - 0.001
      const atTarget = Math.abs(phys.currentDisp - dispForceRef.current * MAX_PUNCH_DISP) < 0.05
      if (frameCount > 30 && stableRef.current >= SETTLE_FRAMES && phys.currentDisp > 0.1 && atTarget && forceFullyRamped) {
        b2phaseRef.current = 'phase2'
        p2StartTimeRef.current = ts
        const snap = snapshotP1(phys, 0, ts)
        recordingRef.current.push(snap)
        finalSnapRef.current = snap
        lastP1SnapRef.current = snap
        for (let i = 0; i <= P2_SNAP_COUNT; i++) {
          recordingRef.current.push({ type: 'p2', p2Progress: i / P2_SNAP_COUNT })
        }
        const p2Frac = (recordingRef.current.length - 1 - P2_SNAP_COUNT) / (recordingRef.current.length - 1)
        onRecordingReady?.(p2Frac)
        onSettled?.()
        return
      }

      rafRef.current = requestAnimationFrame(frame)
    }

    rafRef.current = requestAnimationFrame(frame)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [phase])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <svg
        width="100%" height="100%"
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid slice"
        className="panel-svg"
      >
        <g>
          <rect x={0} y={0} width={VW} height={VH} fill={C.bg} />
          {phase === 'idle' && ions.map((ion, i) => (
            <g key={i}>
              <circle cx={ion.x} cy={ion.y} r={ion.r}
                fill={ion.type === 'Ca' ? C.Ca : C.O} opacity={1}
                stroke={darkMode ? 'rgba(255,255,255,0.50)' : 'rgba(0,0,0,0.22)'} strokeWidth={0.5}
                style={jitterStyle(i * 73 + 29)} />
              {ion.type === 'O' && (
                <circle cx={ion.x + 2.5} cy={ion.y - 2.5} r={1.5}
                  fill="white" opacity={1}
                  style={jitterStyle(i * 73 + 29)} />
              )}
            </g>
          ))}
          {grains.map((g, gi) => (
            <g key={g.id}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h} fill="none" stroke="none" rx={3} />
              {phase === 'idle' && lattices[gi].map((node, ni) => (
                <circle key={ni} cx={node.x} cy={node.y}
                  r={node.type === 'Si' ? 4 : 3}
                  fill={node.type === 'Si' ? C.Si : C.O} opacity={1}
                  stroke={darkMode ? 'rgba(255,255,255,0.50)' : 'rgba(0,0,0,0.22)'} strokeWidth={0.5}
                  style={jitterStyle((gi * 500 + ni) * 137 + 42)} />
              ))}
            </g>
          ))}
        </g>
      </svg>

      <canvas ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />

      <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid slice"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <defs>
          <linearGradient id="field-grad-b" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%"   stopColor="rgb(200,196,188)" />
            <stop offset="20%"  stopColor="rgb(195,90,255)" />
            <stop offset="55%"  stopColor="rgb(240,30,225)" />
            <stop offset="100%" stopColor="rgb(255,70,185)" />
          </linearGradient>
        </defs>
{label && (
          <text x={(VW-VH)/2 + 10} y={18}
            style={{ fontSize: '10px', fontFamily: 'system-ui,sans-serif', fontWeight: 700, letterSpacing: '0.12em' }}
            fill={accentColor} opacity={0.85}>
            {label.toUpperCase()}
          </text>
        )}
      </svg>
    </div>
  )
}
