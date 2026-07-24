import { useMemo } from 'react'

const DEFORM = { 0: 0.35, 20: 0.70, 40: 1.0, 60: 0.85, 80: 1.25 }

// Jaggedness parameters by sand%: more sand → more segments, larger lateral swings
const CRACK_CFG = {
   0: { nSegs:  1, dev: 0.00 },
  20: { nSegs:  3, dev: 0.06 },
  40: { nSegs:  7, dev: 0.13 },
  60: { nSegs: 11, dev: 0.20 },
  80: { nSegs: 17, dev: 0.28 },
}

function makeRand(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 }
}

// Returns normalised [x, y] pairs — x in [0,1] across block width, y in [0,1] down
function generateCrack(sandPct, seed) {
  const { nSegs, dev } = CRACK_CFG[sandPct] ?? CRACK_CFG[40]
  if (nSegs <= 1) return [[0.5, 0], [0.5, 1.0]]
  const rand = makeRand(seed)
  const pts = [[0.5, 0]]
  let x = 0.5
  for (let i = 1; i <= nSegs; i++) {
    x += (rand() - 0.5) * dev * 2
    x = Math.max(0.06, Math.min(0.94, x))
    pts.push([x, i / nSegs])
  }
  return pts
}

export default function MacroPanel({ phase = 'idle', force = 0, sandPct = 40, layoutSeed = 0 }) {
  const blockW = 180
  const blockH = 90
  const plateH = 14
  const punchW = 60
  const cx     = 175   // shifted right; left strip holds kN readout
  const cy     = 180

  const maxArrowLen = 70
  const arrowHeadH  = 12
  const arrowHeadW  = 14

  // ── Deformation ────────────────────────────────────────────────
  const deformFactor  = DEFORM[sandPct] ?? 1.0
  const compression   = force * 0.03 * deformFactor
  const bulge         = compression * 0.20

  const currentBlockH = blockH * (1 - compression)
  const currentBlockW = blockW * (1 + bulge)

  const blockY       = cy - currentBlockH / 2
  const blockX       = cx - currentBlockW / 2
  const bottomPlateY = cy + currentBlockH / 2

  const punchY   = blockY - plateH
  const arrowTip = punchY
  const arrowLen = force * maxArrowLen
  const arrowBase = arrowTip - arrowLen

  // ── Fixed viewBox (sized for max arrow, no shift during ramp) ──
  const initPunchY = cy - blockH / 2 - plateH
  const vbTop    = initPunchY - maxArrowLen - 18
  const vbLeft   = 0
  const vbRight  = cx + blockW / 2 + 20
  const vbBottom = cy + blockH / 2 + plateH + 22
  const viewBox  = `${vbLeft} ${vbTop} ${vbRight - vbLeft} ${vbBottom - vbTop}`

  // ── kN readout (left strip, centered at x≈42) ──────────────────
  const kNx       = (cx - blockW / 2) / 2   // center of left strip
  const forceKN   = Math.round(force * 1200)
  const showForce = phase !== 'idle' || force > 0

  // ── Crack path ─────────────────────────────────────────────────
  const crackPts = useMemo(
    () => generateCrack(sandPct, layoutSeed * 7919 + sandPct * 137),
    [sandPct, layoutSeed]
  )

  function blockPath(pts) {
    return pts.map(([xn, yn], i) => {
      const x = (blockX + xn * currentBlockW).toFixed(1)
      const y = (blockY + yn * currentBlockH).toFixed(1)
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    }).join(' ')
  }

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      className="panel-svg"
    >
      {/* ── kN readout ── */}
      {showForce && (
        <>
          <text x={kNx} y={cy - 6} textAnchor="middle" className="force-value-num">
            {forceKN}
          </text>
          <text x={kNx} y={cy + 14} textAnchor="middle" className="force-value-unit">
            kN
          </text>
        </>
      )}

      {/* ── Force arrow (grows with force) ── */}
      {arrowLen > arrowHeadH && (
        <line
          x1={cx} y1={arrowBase}
          x2={cx} y2={arrowTip - arrowHeadH + 1}
          stroke="#d4813a" strokeWidth={5} strokeLinecap="round"
        />
      )}
      <polygon
        points={`${cx - arrowHeadW / 2},${arrowTip - arrowHeadH} ${cx + arrowHeadW / 2},${arrowTip - arrowHeadH} ${cx},${arrowTip}`}
        fill="#d4813a"
      />

      {/* ── Punch plate ── */}
      <rect
        x={cx - punchW / 2} y={punchY}
        width={punchW} height={plateH}
        fill="#666" rx={2}
      />

      {/* ── Concrete block ── */}
      <rect
        x={blockX} y={blockY}
        width={currentBlockW} height={currentBlockH}
        fill="#a8a09a" stroke="#7a7168" strokeWidth={1.5}
      />

      {[0.30, 0.65].map((t, i) => (
        <line key={i}
          x1={blockX + 8}                  y1={blockY + currentBlockH * t}
          x2={blockX + currentBlockW - 8}  y2={blockY + currentBlockH * t}
          stroke="#8a8278" strokeWidth={0.8} opacity={0.4}
        />
      ))}

      {/* ── Crack ── */}
      {phase === 'failed' && (
        <path
          d={blockPath(crackPts)}
          stroke="#1c1c1c"
          strokeWidth={2.5}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength="1"
          className="crack"
        />
      )}

      {/* ── Bottom support plate ── */}
      <rect
        x={cx - blockW / 2 - 10} y={bottomPlateY}
        width={blockW + 20} height={plateH}
        fill="#555" rx={2}
      />

      {/* ── Dim label (idle only) ── */}
      {phase === 'idle' && (
        <text x={cx} y={vbBottom - 6} textAnchor="middle" className="dim-label">
          150 × 300 mm cylinder
        </text>
      )}
    </svg>
  )
}
