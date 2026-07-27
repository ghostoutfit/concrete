import { useMemo, useRef, useEffect } from 'react'

export const VW = 600
export const VH = 350
const MATRIX_SPACING = 16
const H_STEP = MATRIX_SPACING * 2
const V_STEP = MATRIX_SPACING
const SI_PAD = MATRIX_SPACING / 2

// ── Physics constants ──────────────────────────────────────────
// Kinematic punch: slider sets target displacement; physics ramps to it.
// Break strains are tuned so bonds color visibly and crack around force≈0.5–0.8.
// Punch spans y0 < 3×SPACING (y=8,24,40). First free layer at y=56.
// Chain: 17 free layers × rest=16 → 18 bonds in series → 288 SVG units.
//   uniform strain = currentDisp / 288
//   cc-near non-weakened (2.0%) → never breaks at MAX_PUNCH_DISP=5
//   cc-near pre-weakened  (1.1%) → cracks at disp = 1.1% × 288 = 3.17 → 63% force
const GAMMA           = 0.003  // overdamped drag — equilibrates in <1 frame at this setting
const SUBSTEPS        = 30
const DT              = 1/60
const MAX_PUNCH_DISP  = 8      // max punch travel in SVG units
const PUNCH_RAMP      = 0.04   // SVG units per frame
const VISUAL_SCALE    = 5      // amplify displacements for visibility (educational exaggeration)
const SETTLE_VEL      = 0.08
const SETTLE_FRAMES   = 15
const FORCE_RAMP_RATE = 0.004  // per frame — ~4s to reach full force at 60fps

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
  'cs':      0.18,   // high threshold — cs bonds stretch visibly before breaking
}
const NEAR_BOND  = MATRIX_SPACING * 1.15           // ~18.4 px
const DIAG_BOND  = MATRIX_SPACING * Math.SQRT2 * 1.1 // ~24.9 px
const GRAIN_BOND = H_STEP + 4                      // 36 px  (max intra-grain)
const IFACE_BOND = MATRIX_SPACING * 1.7            // ~27 px

// Precomputed strain colour buckets (0–10 mapping over breakStrain)
// Designed to contrast against the beige background (#ede8df)
const STRAIN_COLORS = (() => {
  const out = []
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    if (t < 0.30) {
      // Resting / low strain: dark grey-blue, clearly visible on beige
      out.push(`rgba(40,50,90,${(0.55 + t * 0.6).toFixed(2)})`)
    } else if (t < 0.70) {
      const u = (t - 0.30) / 0.40
      // dark blue → yellow-orange
      const r = Math.round(40  + u * 215)
      const g = Math.round(50  + u * 150)
      const b = Math.round(90  - u * 90)
      out.push(`rgba(${r},${g},${b},0.92)`)
    } else {
      const u = (t - 0.70) / 0.30
      // orange → bright red
      const g = Math.round(200 * (1 - u))
      out.push(`rgba(255,${g},0,0.97)`)
    }
  }
  return out
})()

function strainBucket(strain, breakStrain) {
  return Math.min(10, Math.floor(Math.abs(strain) / breakStrain * 10))
}

// ── Crack fault-line constants ─────────────────────────────────
// The crack path is predetermined from grain geometry (v1 algorithm).
// Bonds within FAULT_CORRIDOR px of the path are pre-weakened so the
// fault activates under any load — even a small force strains fault
// bonds visibly while bulk bonds stay near-zero.
const FAULT_CORRIDOR    = 18    // px half-width of weak zone
const FAULT_K_FACTOR    = 0.30  // fault bonds 70% softer → stretch more per unit load
const FAULT_BREAK_FACTOR = 0.40  // fault bonds break at 40% of normal strain

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

export function buildCrackWaypoints(grains) {
  const midX = VW / 2
  const waypoints = [{ x: midX, y: 0 }]
  if (grains.length === 0) {
    waypoints.push({ x: midX, y: VH })
    return waypoints
  }
  const margin = 10
  const obs = grains.map(g => ({
    x1: g.x - margin, y1: g.y - margin,
    x2: g.x + g.w + margin, y2: g.y + g.h + margin,
  }))
  let curX = midX, curY = 0
  for (let iters = 0; curY < VH && iters < 300; iters++) {
    const next = obs
      .filter(o => o.y2 > curY && o.x1 < curX && o.x2 > curX)
      .sort((a, b) => a.y1 - b.y1)[0]
    if (!next) break
    const distLeft = curX - next.x1
    const distRight = next.x2 - curX
    let routeX = distLeft <= distRight ? next.x1 : next.x2
    routeX = Math.max(6, Math.min(VW - 6, routeX))
    const approachY = Math.max(next.y1, curY)
    if (approachY > curY + 1) waypoints.push({ x: curX, y: approachY })
    waypoints.push({ x: routeX, y: approachY })
    waypoints.push({ x: routeX, y: next.y2 })
    curY = next.y2
    curX = routeX
  }
  waypoints.push({ x: curX, y: VH })
  return waypoints
}

// ── Seeded PRNG ────────────────────────────────────────────────
function makeRand(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 }
}

// ── Grain layout (same as before) ─────────────────────────────
const GRAIN_CFG = {
  0:  { count: 0,  minCols: 0, maxCols: 0, minRows: 0, maxRows: 0 },
  20: { count: 3,  minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
  40: { count: 6,  minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
  60: { count: 11, minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
  80: { count: 18, minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
}
const GRAIN_GRID = { 20: [3, 1], 40: [3, 2], 60: [4, 3], 80: [6, 3] }

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
  const count = cfg.count
  const [cols, rows] = GRAIN_GRID[sandPct] ?? [1, 1]
  const cellW = VW / cols
  const cellH = VH / rows
  const cells = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      cells.push({ cx: (c + 0.5) * cellW, cy: (r + 0.5) * cellH })
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[cells[i], cells[j]] = [cells[j], cells[i]]
  }
  const grains = []
  for (let i = 0; i < count; i++) {
    const siCols = cfg.minCols + Math.round(rand() * (cfg.maxCols - cfg.minCols))
    const siRows = cfg.minRows + Math.round(rand() * (cfg.maxRows - cfg.minRows))
    const { w, h } = grainDims(siCols, siRows)
    const { cx, cy } = cells[i]
    const rawX = cx + (rand() - 0.5) * cellW * 0.40 - w / 2
    const rawY = cy + (rand() - 0.5) * cellH * 0.40 - h / 2
    const x = Math.round(rawX / MATRIX_SPACING) * MATRIX_SPACING
    // Clamp grains to y≥96 so top grain-Si is at y=104. Matrix rows above y=96 are
    // unobstructed. cs bonds form LATERALLY (grain sides ↔ adjacent matrix at same depth)
    // rather than vertically above the grain where compression would crush the chain.
    const y = Math.max(Math.round(rawY / MATRIX_SPACING) * MATRIX_SPACING, MATRIX_SPACING * 6)
    grains.push({ x, y, w, h, id: i, siCols, siRows })
  }
  return grains
}

function buildLattice(g) {
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
        if (sc < siCols - 1)
          nodes.push({ x: g.x + SI_PAD + sc * H_STEP + H_STEP / 2, y: yO, type: 'O' })
      }
    }
  }
  return nodes
}

function buildIons(grains) {
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
      const type = (col + row) % 2 === 0 ? 'Ca' : 'O'
      ions.push({ type, x, y, r: type === 'Ca' ? 5.5 : 3 })
    }
  }
  return ions
}

// ── Physics engine ─────────────────────────────────────────────
function buildPhysics(ions, grains, lattices, calcScope, crackWaypoints) {
  const punchX = VW / 2
  const punchContactHW = 32   // half-width of punch contact zone

  // Build particle list: matrix ions first, then grain atoms
  const particles = []

  ions.forEach(ion => {
    particles.push({
      x0: ion.x, y0: ion.y, x: ion.x, y: ion.y,
      vx: 0, vy: 0,
      isGrain: false, grainIdx: -1,
      fixed: false, isPunch: false, inScope: false,
      type: ion.type, r: ion.r,   // needed for canvas drawing
    })
  })
  const matrixCount = particles.length

  // Grain atoms are rigid inclusions (sand grains are ~1000× stiffer than paste).
  // They are fixed and don't form cs bonds — only visual/structural markers.
  lattices.forEach((lat, gi) => {
    lat.forEach(node => {
      particles.push({
        x0: node.x, y0: node.y, x: node.x, y: node.y,
        vx: 0, vy: 0,
        isGrain: true, grainIdx: gi,
        fixed: true, isPunch: false, inScope: false,
      })
    })
  })

  const n = particles.length

  // Classify each particle
  particles.forEach(p => {
    let inScope
    switch (calcScope) {
      case 'everything':
        inScope = true
        break
      case 'stress-cone':
        // 45° cone from punch centre, expanding downward
        inScope = Math.abs(p.x - punchX) <= p.y + 1
        break
      case 'top-half':
        inScope = p.y < VH / 2
        break
      case 'crack-zone':
        // Particles within 10 atom-spacings of the crack fault path.
        // Only these atoms move — shows two blocks shearing past each other.
        inScope = distToPath(p.x0, p.y0, crackWaypoints) < 10 * MATRIX_SPACING
        break
      default:
        inScope = true
    }
    p.inScope = inScope
    // Fixed: grain atoms (rigid inclusions), bottom edge, or outside scope
    p.fixed = p.isGrain || !inScope || p.y > VH - MATRIX_SPACING * 1.5
    // Punch spans three particle rows (y0=8,24,40) — extends deep enough to
    // avoid grain atoms at y=56 from blocking the load path.
    p.isPunch = inScope && !p.fixed && p.y0 < MATRIX_SPACING * 3
  })

  // Build bonds
  const bonds = []
  for (let i = 0; i < n; i++) {
    const pi = particles[i]
    for (let j = i + 1; j < n; j++) {
      const pj = particles[j]
      // Skip if neither is in scope (no force can reach them)
      if (!pi.inScope && !pj.inScope) continue

      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d = Math.hypot(dx, dy)

      let bondType = null
      if (!pi.isGrain && !pj.isGrain) {
        if (d <= NEAR_BOND) bondType = 'cc-near'
        else if (d <= DIAG_BOND) bondType = 'cc-diag'
      } else if (pi.isGrain && pj.isGrain && pi.grainIdx === pj.grainIdx) {
        if (d <= GRAIN_BOND) bondType = 'ss'
      } else if (pi.isGrain !== pj.isGrain) {
        // Cement-sand interface bonds. Grains are clamped deep enough that these
        // form laterally (grain sides ↔ adjacent matrix), not vertically above the
        // grain where compression would snap them immediately.
        if (d <= IFACE_BOND) bondType = 'cs'
      }

      if (!bondType) continue

      // Pre-weaken matrix bonds at the punch-face only (y0 < 3×SPACING = 48).
      const nearPunch = bondType !== 'cs' &&
        ((pi.y < MATRIX_SPACING * 3 && Math.abs(pi.x - punchX) < punchContactHW * 1.5) ||
         (pj.y < MATRIX_SPACING * 3 && Math.abs(pj.x - punchX) < punchContactHW * 1.5))
      const punchBreak = nearPunch ? BOND_BREAK[bondType] * 0.55 : BOND_BREAK[bondType]

      // Pre-weaken bonds along the predetermined crack fault path.
      // Grain internal bonds (ss) are excluded — the crack runs through matrix only.
      // Softer K means fault bonds deform more than bulk bonds at the same load,
      // making them visibly strained even at low force levels.
      const midBx = (pi.x0 + pj.x0) / 2
      const midBy = (pi.y0 + pj.y0) / 2
      const onFault = bondType !== 'ss' && distToPath(midBx, midBy, crackWaypoints) < FAULT_CORRIDOR

      bonds.push({
        i, j,
        restLen: d,
        k:          onFault ? BOND_K[bondType] * FAULT_K_FACTOR    : BOND_K[bondType],
        breakStrain: onFault ? punchBreak * FAULT_BREAK_FACTOR       : punchBreak,
        strain: 0,
        broken: false,
        type: bondType,
        isFault: onFault,
      })
    }
  }

  // Pre-allocate force buffers
  const fx = new Float32Array(n)
  const fy = new Float32Array(n)

  return { particles, bonds, n, matrixCount, fx, fy, currentDisp: 0 }
}

function stepPhysics(phys, forceVal) {
  const { particles, bonds, n, fx, fy } = phys
  const dt = DT / SUBSTEPS

  // Distribute the punch ramp across substeps so the chain equilibrates
  // incrementally. One big jump per frame causes the top bond to see
  // ~10× too much strain transiently and break too early.
  const targetDisp = forceVal * MAX_PUNCH_DISP
  const gap = targetDisp - phys.currentDisp
  const totalRamp = Math.sign(gap) * Math.min(PUNCH_RAMP, Math.abs(gap))
  const rampPerSub = totalRamp / SUBSTEPS

  let maxV = 0

  for (let sub = 0; sub < SUBSTEPS; sub++) {
    // Advance punch by one micro-step each substep
    phys.currentDisp += rampPerSub
    for (let i = 0; i < n; i++) {
      if (particles[i].isPunch) particles[i].y = particles[i].y0 + phys.currentDisp
    }
    fx.fill(0)
    fy.fill(0)

    for (let b = 0; b < bonds.length; b++) {
      const bond = bonds[b]
      if (bond.broken) continue
      const pi = particles[bond.i]
      const pj = particles[bond.j]
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d = Math.hypot(dx, dy)
      if (d < 0.001) continue
      const strain = (d - bond.restLen) / bond.restLen
      bond.strain = strain
      if (Math.abs(strain) > bond.breakStrain) {
        bond.broken = true
        continue
      }
      const f = bond.k * (d - bond.restLen)
      const nx = dx / d, ny = dy / d
      if (!pi.fixed && !pi.isPunch) { fx[bond.i] += f * nx; fy[bond.i] += f * ny }
      if (!pj.fixed && !pj.isPunch) { fx[bond.j] -= f * nx; fy[bond.j] -= f * ny }
    }

    for (let i = 0; i < n; i++) {
      const p = particles[i]
      if (p.fixed || p.isPunch) continue
      const vx = fx[i] / GAMMA
      const vy = fy[i] / GAMMA
      p.x += vx * dt
      p.y += vy * dt
      const v = Math.hypot(vx, vy)
      if (v > maxV) maxV = v
    }
  }

  return maxV
}

// ── Canvas scene rendering (atoms + bonds at physics positions) ──
function drawScene(canvas, phys, crackFraction, crackWaypoints) {
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

  // Match SVG xMidYMid meet transform
  const scale   = Math.min(W / VW, H / VH) * dpr
  const offsetX = (W * dpr - VW * scale) / 2
  const offsetY = (H * dpr - VH * scale) / 2
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY)

  const { particles, bonds, matrixCount } = phys

  // Visual position: amplify displacement from rest for educational clarity
  const vx = p => p.x0 + (p.x - p.x0) * VISUAL_SCALE
  const vy = p => p.y0 + (p.y - p.y0) * VISUAL_SCALE

  // ── Bonds (only draw bonds with meaningful strain — bucket 1+) ──
  const batches = Array.from({ length: 11 }, () => [])
  for (let b = 0; b < bonds.length; b++) {
    const bond = bonds[b]
    if (bond.broken || bond.type === 'ss') continue
    const bucket = strainBucket(bond.strain, bond.breakStrain)
    if (bucket === 0) continue   // hide at-rest / near-zero-strain bonds
    batches[bucket].push(b)
  }

  for (let bucket = 1; bucket <= 10; bucket++) {
    const list = batches[bucket]
    if (!list.length) continue
    ctx.strokeStyle = STRAIN_COLORS[bucket]
    ctx.lineWidth = 1.8
    ctx.beginPath()
    for (const b of list) {
      const bond = bonds[b]
      const pi = particles[bond.i]
      const pj = particles[bond.j]
      ctx.moveTo(vx(pi), vy(pi))
      ctx.lineTo(vx(pj), vy(pj))
    }
    ctx.stroke()
  }

  // ── Matrix atoms at amplified physics positions ─────────────────
  for (let i = 0; i < matrixCount; i++) {
    const p = particles[i]
    ctx.beginPath()
    ctx.arc(vx(p), vy(p), p.r, 0, Math.PI * 2)
    ctx.fillStyle = p.type === 'Ca' ? C.Ca : C.O
    ctx.globalAlpha = 0.85
    ctx.fill()
  }
  ctx.globalAlpha = 1

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
  Si: '#d4a020', O: '#cc3a3a', Ca: '#4a96be',
  bg: '#ede8df', grain: '#d8cb98', stroke: '#a09050',
}

function LegendDot({ cx, cy, r, fill, label }) {
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill={fill} />
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

  const TOP_Y  = MATRIX_SPACING * 5          // 80 px — below punch zone
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
  // Top-half breakthrough: strips 0 and 1 covered (y = TOP_Y to midpoint).
  // Deep bonds see little stress from a narrow punch (stress bulb), so only
  // requiring top-half coverage matches real fracture initiation behaviour.
  return covered[0] && covered[1]
}

// ── MicroPanel component ───────────────────────────────────────
export default function MicroPanel({ sandPct, phase = 'idle', layoutSeed = 0, force = 0, calcScope = 'everything', crackWaypoints: crackWaypointsProp, onSettled, onFailed }) {
  const grains             = useMemo(() => buildGrains(sandPct, layoutSeed * 7919 + sandPct * 137 + 42), [sandPct, layoutSeed])
  const ions               = useMemo(() => buildIons(grains), [grains])
  const lattices           = useMemo(() => grains.map(buildLattice), [grains])
  const crackWaypointsSelf = useMemo(() => buildCrackWaypoints(grains), [grains])
  const crackWaypoints     = crackWaypointsProp ?? crackWaypointsSelf
  const crackD             = useMemo(() => smoothPath(crackWaypoints), [crackWaypoints])

  const svgRef    = useRef(null)
  const canvasRef = useRef(null)
  const physRef   = useRef(null)
  const rafRef    = useRef(null)
  const forceRef     = useRef(force)
  const dispForceRef = useRef(0)    // animated ramp: 0 → forceRef.current
  const stableRef    = useRef(0)    // consecutive stable frames

  // Keep forceRef in sync with prop (picked up inside RAF without restart)
  useEffect(() => { forceRef.current = force }, [force])

  // Rebuild physics whenever layout or scope changes
  useEffect(() => {
    physRef.current = buildPhysics(ions, grains, lattices, calcScope, crackWaypoints)
  }, [ions, grains, lattices, calcScope, crackWaypoints])

  // RAF loop: run when testing, stop otherwise
  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)

    if (phase === 'idle') {
      // Reset physics to rest positions and clear canvas
      physRef.current = buildPhysics(ions, grains, lattices, calcScope, crackWaypoints)
      stableRef.current = 0
      dispForceRef.current = 0
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      return
    }

    if (phase !== 'testing') return  // 'settled'/'failed' — keep canvas as-is

    stableRef.current = 0
    dispForceRef.current = 0   // always ramp from zero so crack forms as animation
    let frameCount = 0
    let prevBroken = 0

    function frame() {
      const phys = physRef.current
      if (!phys) return

      // Ramp displayed force from 0 toward slider value each frame
      dispForceRef.current = Math.min(forceRef.current, dispForceRef.current + FORCE_RAMP_RATE)

      const maxV = stepPhysics(phys, dispForceRef.current)

      // Crack fraction: fraction of non-ss fault bonds broken → drives partial crack draw
      const faultBonds  = phys.bonds.filter(b => b.isFault && b.type !== 'ss')
      const faultBroken = faultBonds.filter(b => b.broken).length
      const crackFraction = faultBonds.length > 0 ? faultBroken / faultBonds.length : 0

      drawScene(canvasRef.current, phys, crackFraction, crackWaypoints)
      frameCount++

      const brokenNow = phys.bonds.filter(b => b.broken).length
      const newBreaks  = brokenNow > prevBroken

      // Check for through-crack whenever new bonds break
      if (newBreaks && hasBreakthroughPath(phys.bonds, phys.particles)) {
        onFailed?.()
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
            <circle key={i}
              cx={ion.x} cy={ion.y} r={ion.r}
              fill={ion.type === 'Ca' ? C.Ca : C.O}
              opacity={0.85}
              style={jitterStyle(i * 73 + 29)}
            />
          ))}

          {/* Sand grains */}
          {grains.map((g, gi) => (
            <g key={g.id}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h}
                fill={C.grain} stroke={C.stroke} strokeWidth={1.5} rx={3} />
              {lattices[gi].map((node, ni) => (
                <circle key={ni}
                  cx={node.x} cy={node.y}
                  r={node.type === 'Si' ? 4 : 3}
                  fill={node.type === 'Si' ? C.Si : C.O}
                  opacity={0.82}
                  style={jitterStyle((gi * 500 + ni) * 137 + 42)}
                />
              ))}
            </g>
          ))}

          {/* Legend */}
          <g transform={`translate(10, ${VH - 18})`}>
            <LegendDot cx={6}   cy={0} r={4} fill={C.Si} label="Si" />
            <LegendDot cx={46}  cy={0} r={3} fill={C.O}  label="O (grain)" />
            <LegendDot cx={115} cy={0} r={4} fill={C.Ca} label="Ca²⁺" />
            <LegendDot cx={162} cy={0} r={3} fill={C.O}  label="O²⁻" />
          </g>
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

      {/* Crack overlay — only when specimen actually failed */}
      {phase === 'failed' && (
        <svg
          viewBox={`0 0 ${VW} ${VH}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        >
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
        </svg>
      )}
    </div>
  )
}
