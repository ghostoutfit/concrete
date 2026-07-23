import { useMemo } from 'react'

const VW = 600
const VH = 350

const MATRIX_SPACING = 16  // Ca-O center-to-center distance in the matrix lattice
const H_STEP = MATRIX_SPACING * 2   // Si-to-Si; bridging O sits at the midpoint (= 1 matrix step)
const V_STEP = MATRIX_SPACING       // Si-row → bridging-O-row (2×V_STEP = H_STEP → isotropic)
const SI_PAD = MATRIX_SPACING / 2   // grain edge → first/last Si center
// With SI_PAD = MATRIX_SPACING/2 = 8, every grain dimension is an exact multiple of
// MATRIX_SPACING: width = (siCols-1)*32 + 16, height = (siRows-1)*32 + 16.
// Snapping grain positions to the MATRIX_SPACING grid means every grain atom lands
// on a matrix lattice point, so the two crystals tile seamlessly.

function makeRand(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// Grain dimensions are driven by Si lattice count, not independent width/height.
// Col/row ranges are smaller than before because H_STEP doubled (17→32).
const GRAIN_CFG = {
  0:  { count: 0,  minCols: 0, maxCols: 0, minRows: 0, maxRows: 0 },
  20: { count: 3,  minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
  40: { count: 6,  minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
  60: { count: 11, minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
  80: { count: 18, minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
}

// Grid layout [cols, rows] chosen per count so cells match panel aspect ratio
// and there are zero (or minimal) empty cells
const GRAIN_GRID = { 20: [3, 1], 40: [3, 2], 60: [4, 3], 80: [6, 3] }

// ── Grain sizes computed exactly from Si lattice counts ────────
function grainDims(siCols, siRows) {
  return {
    w: (siCols - 1) * H_STEP + SI_PAD * 2,
    h: (siRows - 1) * 2 * V_STEP + SI_PAD * 2,
  }
}

// Grid-with-jitter placement: one grain per cell, small random offset so the
// layout looks organic but every cell is filled (no large empty zones).
// Edge grains may extend beyond the panel boundary — the SVG clipPath hides
// the overflow, giving a "looking through a window at the microstructure" feel.
function buildGrains(sandPct, seed) {
  const cfg = GRAIN_CFG[sandPct]
  if (!cfg || cfg.count === 0) return []
  const rand = makeRand(seed)
  const count = cfg.count

  const [cols, rows] = GRAIN_GRID[sandPct] ?? [1, 1]
  const cellW = VW / cols
  const cellH = VH / rows

  // Shuffle cells so the one empty slot (when count < cols*rows) is random
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
    // Snap to MATRIX_SPACING grid so grain atoms align with the matrix lattice
    const x = Math.round(rawX / MATRIX_SPACING) * MATRIX_SPACING
    const y = Math.round(rawY / MATRIX_SPACING) * MATRIX_SPACING
    grains.push({ x, y, w, h, id: i, siCols, siRows })
  }
  return grains
}

// ── Si-O lattice, perfectly fitted to grain bounds ─────────────
// Si rows (even) + bridging-O rows between them (no trailing row)
// O atoms are only generated between adjacent Si atoms — no hanging bridges
function buildLattice(g) {
  const { siCols, siRows } = g
  const nodes = []

  for (let si = 0; si < siRows; si++) {
    const y = g.y + SI_PAD + si * 2 * V_STEP

    // Si row + horizontal O bridges (only between consecutive Si pairs)
    for (let sc = 0; sc < siCols; sc++) {
      const x = g.x + SI_PAD + sc * H_STEP
      nodes.push({ x, y, type: 'Si' })
      if (sc < siCols - 1) nodes.push({ x: x + H_STEP / 2, y, type: 'O' })
    }

    // Bridging O row below this Si row (skip after the last Si row)
    // Two O per gap: one below each Si, one at the diagonal midpoint between Si columns.
    // This fills every 16 px grid position, matching the matrix density exactly.
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

// ── Matrix ions: rock-salt crystal lattice (Ca²⁺ / O²⁻ alternating) ──
// Ca where (col+row) even, O where odd — 2D slice of NaCl-type structure.
// Grid points inside grain boundaries (+ clearance) are simply skipped.
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

// ── Crack routing: smooth Bezier through waypoints ─────────────
function smoothPath(pts) {
  if (pts.length === 0) return ''
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

// Per-particle jitter: 4 fully independent random displacements + unique duration/delay
function jitterStyle(idx) {
  // Wang hash — good avalanche, cheap
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

// Greedy top→bottom sweep: find each grain that blocks curX, deflect left or right
function buildCrackPath(grains) {
  const midX = VW / 2

  if (grains.length === 0) {
    const wpts = [{ x: midX, y: 0 }, { x: midX, y: VH }]
    return { waypoints: wpts, d: `M ${midX},0 L ${midX},${VH}` }
  }

  const margin = 10
  const obs = grains.map(g => ({
    x1: g.x - margin, y1: g.y - margin,
    x2: g.x + g.w + margin, y2: g.y + g.h + margin,
  }))

  const waypoints = [{ x: midX, y: 0 }]
  let curX = midX
  let curY = 0

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
    // L-shaped route: go straight down to grain top, then step sideways.
    // This prevents diagonal segments from clipping other grains.
    if (approachY > curY + 1) {
      waypoints.push({ x: curX, y: approachY })
    }
    waypoints.push({ x: routeX, y: approachY })
    waypoints.push({ x: routeX, y: next.y2 })

    curY = next.y2
    curX = routeX
  }

  waypoints.push({ x: curX, y: VH })
  return { waypoints, d: smoothPath(waypoints) }
}

// Given a y coordinate, interpolate the crack x position along the waypoint path.
function crackXAt(y, waypoints) {
  if (!waypoints || waypoints.length < 2) return VW / 2
  for (let i = waypoints.length - 2; i >= 0; i--) {
    if (waypoints[i].y <= y) {
      const p0 = waypoints[i], p1 = waypoints[i + 1]
      if (p0.y === p1.y) return p1.x  // horizontal step: snap to end position
      const t = Math.min(1, (y - p0.y) / (p1.y - p0.y))
      return p0.x + t * (p1.x - p0.x)
    }
  }
  return waypoints[0].x
}

// ── Separation displacement modes ──────────────────────────────
// Both modes compute displacement perpendicular to the nearest point on the crack
// polyline so particles always push AWAY — no "crushing together" at bends.
// shift:  constant magnitude regardless of distance
// squish: magnitude falls off exponentially with distance; particles right at the
//         crack edge get max push, particles far away barely move
const SHIFT_PUSH  = 14
const SQUISH_PUSH = 28, SQUISH_DECAY = 60

function nearestCrackPoint(px, py, waypoints) {
  let best = { x: waypoints[0].x, y: waypoints[0].y, d: Infinity }
  for (let i = 0; i < waypoints.length - 1; i++) {
    const p0 = waypoints[i], p1 = waypoints[i + 1]
    const ex = p1.x - p0.x, ey = p1.y - p0.y
    const len2 = ex * ex + ey * ey
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - p0.x) * ex + (py - p0.y) * ey) / len2))
    const cx = p0.x + t * ex, cy = p0.y + t * ey
    const d = Math.hypot(px - cx, py - cy)
    if (d < best.d) best = { x: cx, y: cy, d }
  }
  return best
}

function computeDisp(px, py, crackWaypoints, mode) {
  const { x: cx, y: cy, d } = nearestCrackPoint(px, py, crackWaypoints)
  if (d < 0.5) return { dx: 0, dy: 0 }
  const nx = (px - cx) / d
  const ny = (py - cy) / d
  if (mode === 'squish') {
    const push = SQUISH_PUSH * Math.exp(-d / SQUISH_DECAY)
    return { dx: nx * push, dy: ny * push }
  }
  return { dx: nx * SHIFT_PUSH, dy: ny * SHIFT_PUSH }
}

// Grains move purely horizontally, direction determined by which side of the fissure
// their centre falls on.  This guarantees grains on opposite sides always separate —
// no diagonal push, no risk of moving toward a grain across the fissure.
function computeGrainDisp(g, crackWaypoints, mode) {
  const gcy = g.y + g.h / 2
  const crackX = crackXAt(gcy, crackWaypoints)
  const side = (g.x + g.w / 2) < crackX ? -1 : 1   // -1 left, +1 right

  if (mode === 'squish') {
    const nearEdgeX = side < 0 ? g.x + g.w : g.x    // crack-facing edge
    const edgeDist  = Math.abs(nearEdgeX - crackX)
    return { dx: side * SQUISH_PUSH * Math.exp(-edgeDist / SQUISH_DECAY), dy: 0 }
  }
  return { dx: side * SHIFT_PUSH, dy: 0 }
}

const C = {
  Si:    '#d4a020',
  O:     '#cc3a3a',
  Ca:    '#4a96be',
  bg:    '#ede8df',
  grain: '#d8cb98',
  stroke:'#a09050',
}

function LegendDot({ cx, cy, r, fill, label }) {
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill={fill} />
      <text x={cx + r + 5} y={cy + 4} className="micro-legend">{label}</text>
    </>
  )
}

export default function MicroPanel({ sandPct, phase = 'idle', layoutSeed = 0, separationMode = 'shift' }) {
  const grains    = useMemo(
    () => buildGrains(sandPct, layoutSeed * 7919 + sandPct * 137 + 42),
    [sandPct, layoutSeed]
  )
  const ions      = useMemo(() => buildIons(grains), [grains])
  const lattices  = useMemo(() => grains.map(buildLattice), [grains])
  const { waypoints: crackWaypoints, d: crackPath } = useMemo(
    () => buildCrackPath(grains),
    [grains]
  )

  return (
    <svg
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

        {/* Matrix ions — snap apart in sequence as crack front passes their y position */}
        {ions.map((ion, i) => {
          const { dx, dy } = phase === 'failed'
            ? computeDisp(ion.x, ion.y, crackWaypoints, separationMode)
            : { dx: 0, dy: 0 }
          const delay = phase === 'failed' ? (ion.y / VH * 0.50).toFixed(3) : '0'
          const transition = phase === 'failed'
            ? `transform 0.2s cubic-bezier(0.34,1.56,0.64,1) ${delay}s`
            : 'transform 0.3s ease-out'
          return (
            <g key={i} style={{ transform: `translate(${dx.toFixed(2)}px,${dy.toFixed(2)}px)`, transition }}>
              <circle cx={ion.x} cy={ion.y} r={ion.r}
                fill={ion.type === 'Ca' ? C.Ca : C.O} opacity={0.85}
                style={jitterStyle(i * 73 + 29)} />
            </g>
          )
        })}

        {/* Sand grains — displaced based on nearest boundary point to the crack */}
        {grains.map((g, gi) => {
          const gcy = g.y + g.h / 2
          const { dx, dy } = phase === 'failed'
            ? computeGrainDisp(g, crackWaypoints, separationMode)
            : { dx: 0, dy: 0 }
          const delay = phase === 'failed' ? (gcy / VH * 0.50).toFixed(3) : '0'
          const transition = phase === 'failed'
            ? `transform 0.2s cubic-bezier(0.34,1.56,0.64,1) ${delay}s`
            : 'transform 0.3s ease-out'
          return (
            <g key={g.id} style={{ transform: `translate(${dx.toFixed(2)}px,${dy.toFixed(2)}px)`, transition }}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h}
                fill={C.grain} stroke={C.stroke} strokeWidth={1.5} rx={3} />
              {lattices[gi].map((n, ni) => (
                <circle key={ni} cx={n.x} cy={n.y}
                  r={n.type === 'Si' ? 4 : 3}
                  fill={n.type === 'Si' ? C.Si : C.O}
                  opacity={0.82}
                  style={jitterStyle((gi * 500 + ni) * 137 + 42)} />
              ))}
            </g>
          )
        })}

        {/* Legend */}
        <g transform={`translate(10, ${VH - 18})`}>
          <LegendDot cx={6}   cy={0} r={4}   fill={C.Si} label="Si" />
          <LegendDot cx={46}  cy={0} r={3}   fill={C.O}  label="O (grain)" />
          <LegendDot cx={115} cy={0} r={4}   fill={C.Ca} label="Ca²⁺" />
          <LegendDot cx={162} cy={0} r={3}   fill={C.O}  label="O²⁻" />
        </g>
      </g>
    </svg>
  )
}
