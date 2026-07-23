import { useMemo } from 'react'

const VW = 600
const VH = 350

const H_STEP = 17   // Si-to-Si horizontal spacing
const V_STEP = 11   // Si-row to bridging-O-row spacing
const SI_PAD = 6    // grain edge → first/last Si center (same on all sides)
// With rx=3 on the grain rect, corner Si atoms (r=4) remain safely inside
// the rounded corners: nearest atom tip is only 0.24px from arc center vs radius 3

function makeRand(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// Grain dimensions are driven by Si lattice count, not independent width/height
const GRAIN_CFG = {
  0:  { count: 0,  minCols: 0, maxCols: 0, minRows: 0, maxRows: 0, pad: 14 },
  20: { count: 3,  minCols: 4, maxCols: 9, minRows: 3, maxRows: 7, pad: 14 },
  40: { count: 6,  minCols: 4, maxCols: 9, minRows: 3, maxRows: 7, pad: 10 },
  60: { count: 11, minCols: 4, maxCols: 9, minRows: 3, maxRows: 7, pad: 3  },
  80: { count: 18, minCols: 4, maxCols: 9, minRows: 3, maxRows: 7, pad: -6 },
}

const CA_TARGET = { 0: 240, 20: 165, 40: 105, 60: 60, 80: 21 }

// ── Grain sizes computed exactly from Si lattice counts ────────
function grainDims(siCols, siRows) {
  return {
    w: (siCols - 1) * H_STEP + SI_PAD * 2,
    h: (siRows - 1) * 2 * V_STEP + SI_PAD * 2,
  }
}

function buildGrains(sandPct) {
  const cfg = GRAIN_CFG[sandPct]
  if (!cfg || cfg.count === 0) return []
  const rand = makeRand(sandPct * 137 + 42)
  const grains = []
  const edge = 8

  for (let i = 0; i < cfg.count; i++) {
    const siCols = cfg.minCols + Math.round(rand() * (cfg.maxCols - cfg.minCols))
    const siRows = cfg.minRows + Math.round(rand() * (cfg.maxRows - cfg.minRows))
    const { w, h } = grainDims(siCols, siRows)

    let placed = false
    for (let attempt = 0; attempt < 150; attempt++) {
      const x = edge + rand() * (VW - w - edge * 2)
      const y = edge + rand() * (VH - h - edge * 2)
      const clash = grains.some(g =>
        x < g.x + g.w + cfg.pad && x + w > g.x - cfg.pad &&
        y < g.y + g.h + cfg.pad && y + h > g.y - cfg.pad
      )
      if (!clash) { grains.push({ x, y, w, h, id: i, siCols, siRows }); placed = true; break }
    }
    if (!placed) {
      grains.push({
        x: edge + rand() * (VW - w - edge * 2),
        y: edge + rand() * (VH - h - edge * 2),
        w, h, id: i, siCols, siRows,
      })
    }
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
    if (si < siRows - 1) {
      const yO = y + V_STEP
      for (let sc = 0; sc < siCols; sc++) {
        nodes.push({ x: g.x + SI_PAD + sc * H_STEP, y: yO, type: 'O' })
      }
    }
  }
  return nodes
}

// ── Matrix ions (Ca²⁺ and O²⁻ in the cement paste) ────────────
function buildIons(sandPct, grains) {
  const rand  = makeRand(sandPct * 73 + 99)
  const caN   = CA_TARGET[sandPct] ?? 30
  const ions  = []
  const minD  = 7
  const gPad  = 8

  function inGrain(x, y) {
    return grains.some(g =>
      x > g.x - gPad && x < g.x + g.w + gPad &&
      y > g.y - gPad && y < g.y + g.h + gPad
    )
  }
  function tooClose(x, y) {
    return ions.some(ion => {
      const dx = ion.x - x, dy = ion.y - y
      return dx * dx + dy * dy < minD * minD
    })
  }
  function place(type, r, n) {
    let placed = 0
    for (let a = 0; placed < n && a < n * 80; a++) {
      const x = 8 + rand() * (VW - 16)
      const y = 8 + rand() * (VH - 16)
      if (!inGrain(x, y) && !tooClose(x, y)) { ions.push({ type, x, y, r }); placed++ }
    }
  }
  place('Ca', 5.5, caN)
  place('O',  3,   caN * 2)
  return ions
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

export default function MicroPanel({ sandPct }) {
  const grains   = useMemo(() => buildGrains(sandPct), [sandPct])
  const ions     = useMemo(() => buildIons(sandPct, grains), [sandPct, grains])
  const lattices = useMemo(() => grains.map(buildLattice), [grains])

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${VW} ${VH}`}
      preserveAspectRatio="xMidYMid meet"
      className="panel-svg"
    >
      <rect width={VW} height={VH} fill={C.bg} rx={4} />

      {/* Matrix ions behind grains */}
      {ions.map((ion, i) => (
        <circle key={i} cx={ion.x} cy={ion.y} r={ion.r}
          fill={ion.type === 'Ca' ? C.Ca : C.O} opacity={0.85} />
      ))}

      {/* Sand grains — fill first, then atoms on top (no clipPath needed) */}
      {grains.map((g, gi) => (
        <g key={g.id}>
          <rect x={g.x} y={g.y} width={g.w} height={g.h}
            fill={C.grain} stroke={C.stroke} strokeWidth={1.5} rx={3} />
          {lattices[gi].map((n, ni) => (
            <circle key={ni} cx={n.x} cy={n.y}
              r={n.type === 'Si' ? 4 : 3}
              fill={n.type === 'Si' ? C.Si : C.O}
              opacity={0.82}
            />
          ))}
        </g>
      ))}

      {/* Legend */}
      <g transform={`translate(10, ${VH - 18})`}>
        <LegendDot cx={6}   cy={0} r={4}   fill={C.Si} label="Si" />
        <LegendDot cx={46}  cy={0} r={3}   fill={C.O}  label="O (grain)" />
        <LegendDot cx={115} cy={0} r={4}   fill={C.Ca} label="Ca²⁺" />
        <LegendDot cx={162} cy={0} r={3}   fill={C.O}  label="O²⁻" />
      </g>
    </svg>
  )
}
