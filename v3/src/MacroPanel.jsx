const DEFORM = { 0: 0.30, 20: 0.55, 40: 0.80, 60: 0.65, 80: 1.10 }

export default function MacroPanel({ phase = 'idle', force = 0, onForceChange, sandPct = 40, crackPts = [] }) {
  const beamL  = 160
  const beamH  = 38
  const wallW  = 18
  const wallX  = 25
  const beamX  = wallX + wallW
  const tipX   = beamX + beamL
  const beamY  = 72
  const beamBotY = beamY + beamH

  // Bending: tipDrop is the vertical deflection at the right end (only during/after test)
  const deformFactor = DEFORM[sandPct] ?? 0.80
  const maxTipDrop   = 14
  const tipDrop      = phase === 'idle' ? 0 : force * maxTipDrop * deformFactor

  // Cubic bezier control points — near-zero deflection at wall, full at tip
  const cpX1  = beamX + beamL * 0.33
  const cpX2  = beamX + beamL * 0.67
  const topR  = beamY + tipDrop
  const botR  = beamBotY + tipDrop

  const cpTopY1 = beamY    + tipDrop * 0.06
  const cpTopY2 = beamY    + tipDrop * 0.52
  const cpBotY1 = beamBotY + tipDrop * 0.06
  const cpBotY2 = beamBotY + tipDrop * 0.52

  const outline = [
    `M ${beamX},${beamY}`,
    `C ${cpX1},${cpTopY1} ${cpX2},${cpTopY2} ${tipX},${topR}`,
    `L ${tipX},${botR}`,
    `C ${cpX2},${cpBotY2} ${cpX1},${cpBotY1} ${beamX},${beamBotY}`,
    'Z',
  ].join(' ')

  // Force arrow — at right end, pointing down from above
  const maxArrowLen = 36
  const arrowHeadH  = 10
  const arrowHeadW  = 12
  const arrowLen    = force * maxArrowLen
  const arrowTip    = topR
  const arrowBase   = arrowTip - arrowLen - arrowHeadH

  // Red dot — crack initiation: top surface ~16% from fixed end
  const dotFrac = 0.16
  const dotX = beamX + beamL * dotFrac
  const dotY = beamY  // near-zero deflection at this position

  // ViewBox
  const vbL = 0
  const vbR = tipX + 20
  const vbT = beamY - maxArrowLen - arrowHeadH - 10
  const vbB = beamBotY + maxTipDrop + 10
  const viewBox = `${vbL} ${vbT} ${vbR - vbL} ${vbB - vbT}`

  // Macro crack: independent of micro coordinates — just a vertical line at the red dot
  const macroCrackD = `M ${dotX.toFixed(1)},${beamY} L ${dotX.toFixed(1)},${(beamY + beamH * 0.70).toFixed(1)}`

  const forceKN   = Math.round(force * 1500)
  const sliderVal = Math.round(force * 100)

  return (
    <div className="macro-panel-inner">
      <div className="force-slider-col">
        <span className="force-kn-label">{forceKN}</span>
        <span className="force-kn-unit">kN</span>
        <input
          type="range" className="force-slider" orient="vertical"
          min={0} max={100} step={1} value={sliderVal}
          onChange={e => onForceChange?.(Number(e.target.value) / 100)}
          disabled={phase === 'settled'}
        />
        <span className="force-slider-zero">0</span>
      </div>

      <svg width="100%" height="100%" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" className="panel-svg">

        {/* Fixed wall + hatching */}
        <rect x={wallX} y={beamY - 8} width={wallW} height={beamH + 16} fill="#555" rx={1} />
        {[-3, -2, -1, 0, 1, 2, 3].map(k => (
          <line key={k}
            x1={wallX} y1={beamY + beamH / 2 + k * 8}
            x2={wallX - 12} y2={beamY + beamH / 2 + k * 8 + 10}
            stroke="#3a3a3a" strokeWidth={1.2} strokeLinecap="round"
          />
        ))}

        {/* Beam body */}
        <path d={outline} fill="#a8a09a" stroke="#7a7168" strokeWidth={1.5} />

        {/* Internal texture lines, bent with beam */}
        {[0.33, 0.67].map((t, i) => (
          <path key={i}
            d={`M ${beamX},${beamY + t * beamH} C ${cpX1},${cpTopY1 + t * (cpBotY1 - cpTopY1)} ${cpX2},${cpTopY2 + t * (cpBotY2 - cpTopY2)} ${tipX},${topR + t * beamH}`}
            stroke="#8a8278" strokeWidth={0.8} fill="none" opacity={0.4}
          />
        ))}

        {/* Force arrow at right tip */}
        {arrowLen > 1 && (
          <>
            {arrowLen > arrowHeadH && (
              <line
                x1={tipX} y1={arrowBase}
                x2={tipX} y2={arrowTip - arrowHeadH + 1}
                stroke="#d4813a" strokeWidth={4} strokeLinecap="round"
              />
            )}
            <polygon
              points={`${tipX - arrowHeadW / 2},${arrowTip - arrowHeadH} ${tipX + arrowHeadW / 2},${arrowTip - arrowHeadH} ${tipX},${arrowTip}`}
              fill="#d4813a"
            />
          </>
        )}

        {/* Crack at red dot when failed */}
        {phase === 'failed' && (
          <path
            d={macroCrackD}
            stroke="#1c1c1c" strokeWidth={2} fill="none"
            strokeLinecap="round" pathLength="1" className="crack"
          />
        )}

        {/* Tiny red rectangle — same 12:7 aspect ratio as the micro view */}
        <rect x={dotX - 9} y={dotY - 5.25} width={18} height={10.5} fill="none" stroke="#cc2222" strokeWidth={2.25} />

        {phase === 'idle' && (
          <text x={beamX + beamL / 2} y={vbB - 4} textAnchor="middle" className="dim-label">
            150 × 2400 mm
          </text>
        )}
      </svg>
    </div>
  )
}
