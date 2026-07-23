const DEFORM = { 0: 0.35, 20: 0.70, 40: 1.0, 60: 0.85, 80: 1.25 }

// All cracks originate at [0.5, 0] — centre of the punch-plate contact — and
// propagate downward.  Patterns vary by sand%: brittle splits vs. shear cones.
const CRACKS = {
  0: [  // pure cement paste — vertical splitting failure
    { pts: [[0.5, 0], [0.50, 1.00]], delay: 0,   w: 2.5 },
    { pts: [[0.5, 0], [0.14, 1.00]], delay: 80,  w: 1.5 },
    { pts: [[0.5, 0], [0.86, 1.00]], delay: 80,  w: 1.5 },
  ],
  20: [  // slightly tortuous diagonal shear
    { pts: [[0.5, 0], [0.18, 0.95]], delay: 0,   w: 2.5 },
    { pts: [[0.5, 0], [0.82, 0.90]], delay: 110, w: 1.8 },
  ],
  40: [  // peak-strength mix — classic shear-cone failure
    { pts: [[0.5, 0], [0.05, 0.95]], delay: 0,  w: 3.0 },
    { pts: [[0.5, 0], [0.95, 0.95]], delay: 40, w: 2.5 },
  ],
  60: [  // excess aggregate — cone + secondary splits
    { pts: [[0.5, 0], [0.08, 0.55]], delay: 0,   w: 2.0 },
    { pts: [[0.5, 0], [0.92, 0.50]], delay: 80,  w: 2.0 },
    { pts: [[0.5, 0], [0.22, 1.00]], delay: 130, w: 1.8 },
    { pts: [[0.5, 0], [0.78, 1.00]], delay: 170, w: 1.5 },
  ],
  80: [  // weak paste — many short cracks radiating from punch zone
    { pts: [[0.5, 0], [0.32, 0.45]], delay: 0,  w: 1.5 },
    { pts: [[0.5, 0], [0.68, 0.40]], delay: 28, w: 1.5 },
    { pts: [[0.5, 0], [0.22, 0.80]], delay: 52, w: 1.5 },
    { pts: [[0.5, 0], [0.72, 0.75]], delay: 38, w: 1.5 },
    { pts: [[0.5, 0], [0.42, 1.00]], delay: 65, w: 1.5 },
    { pts: [[0.5, 0], [0.58, 1.00]], delay: 75, w: 1.2 },
    { pts: [[0.5, 0], [0.15, 0.55]], delay: 92, w: 1.2 },
  ],
}

export default function MacroPanel({ phase = 'idle', force = 0, sandPct = 40 }) {
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

  // ── Crack path builder ─────────────────────────────────────────
  function crackD([[x0n, y0n], [x1n, y1n]]) {
    const x0 = blockX + x0n * currentBlockW
    const y0 = blockY + y0n * currentBlockH
    const x1 = blockX + x1n * currentBlockW
    const y1 = blockY + y1n * currentBlockH
    return `M${x0.toFixed(1)},${y0.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)}`
  }

  const cracks = CRACKS[sandPct] ?? []

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

      {/* ── Cracks ── */}
      {phase === 'failed' && cracks.map((c, i) => (
        <path
          key={i}
          d={crackD(c.pts)}
          stroke="#1c1c1c"
          strokeWidth={c.w}
          fill="none"
          strokeLinecap="round"
          pathLength="1"
          className="crack"
          style={{ animationDelay: `${c.delay}ms` }}
        />
      ))}

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
