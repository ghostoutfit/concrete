import { useMemo, useState, useEffect, useRef } from 'react'

const DEFORM = { 0: 0.30, 20: 0.55, 40: 0.80, 60: 0.65, 80: 1.10 }

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

export function generateCrack(sandPct, seed) {
  const { nSegs, dev } = CRACK_CFG[sandPct] ?? CRACK_CFG[0]
  if (nSegs <= 1 || dev === 0) return [[0.5, 0], [0.5, 1]]
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

export default function MacroPanel({ phase = 'idle', force = 0, onForceChange, sandPct = 40, crackPts = [], layoutSeed = 0, arrowScale = 2 }) {
  const beamL  = 160
  const beamH  = 38
  const wallW  = 18
  const wallX  = 25
  const beamX  = wallX + wallW
  const tipX   = beamX + beamL
  const beamY  = 72
  const beamBotY = beamY + beamH

  // Bending: tipDrop is the vertical deflection at the right end
  const deformFactor = DEFORM[sandPct] ?? 0.80
  const maxTipDrop   = 14
  const fullDrop     = force * maxTipDrop * deformFactor
  // Target: almost nothing before crack, full deflection after
  const targetDrop   = phase === 'idle' ? 0
    : (phase === 'testing') ? fullDrop * 0.06
    : fullDrop

  const [tipDrop, setTipDrop] = useState(0)
  const animRef = useRef({ val: 0, rafId: null })

  useEffect(() => {
    cancelAnimationFrame(animRef.current.rafId)
    // Snap for idle/testing (tiny values — lag is invisible)
    if (phase === 'idle' || phase === 'testing') {
      animRef.current.val = targetDrop
      setTipDrop(targetDrop)
      return
    }
    // Smooth lerp when crack hits (failed/settled)
    function tick() {
      const delta = targetDrop - animRef.current.val
      if (Math.abs(delta) < 0.02) { setTipDrop(targetDrop); return }
      animRef.current.val += delta * 0.12
      setTipDrop(animRef.current.val)
      animRef.current.rafId = requestAnimationFrame(tick)
    }
    animRef.current.rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animRef.current.rafId)
  }, [targetDrop, phase])

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

  // Force arrow — scaled independently so it stays legible at any force level
  const maxArrowLen = 36 * arrowScale
  const arrowHeadH  = 10 * arrowScale
  const arrowHeadW  = 12 * arrowScale
  const arrowLen    = force * maxArrowLen
  const arrowTip    = topR
  const arrowBase   = arrowTip - arrowLen - arrowHeadH

  // Red dot — crack initiation: top surface ~16% from fixed end
  const dotFrac = 0.16
  const dotX = beamX + beamL * dotFrac
  const dotY = beamY  // near-zero deflection at this position

  const jaggedPts = useMemo(
    () => generateCrack(sandPct, layoutSeed * 7919 + sandPct * 137),
    [sandPct, layoutSeed]
  )
  const macroCrackD = jaggedPts.map(([xn, yn], i) => {
    const x = (dotX + (xn - 0.5) * beamH * 0.50).toFixed(1)
    const y = (beamY + yn * beamH * 0.70).toFixed(1)
    return `${i === 0 ? 'M' : 'L'}${x},${y}`
  }).join(' ')

  // ViewBox
  const vbL = 0
  const vbR = tipX + 20
  const vbT = beamY - maxArrowLen - arrowHeadH - 10
  const vbB = beamBotY + maxTipDrop + 10
  const viewBox = `${vbL} ${vbT} ${vbR - vbL} ${vbB - vbT}`

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
                stroke="#d4813a" strokeWidth={4 * Math.min(arrowScale, 2)} strokeLinecap="round"
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
