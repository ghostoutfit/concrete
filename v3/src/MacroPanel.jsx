import { useMemo, useState, useEffect, useRef } from 'react'

const DEFORM = { 0: 0.30, 20: 0.55, 40: 0.80, 60: 0.65, 80: 1.10 }

function makeRand(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 }
}

// Inserts a jittered midpoint between each pair of waypoints for irregular feel
function jitterPath(pts, amount, rand) {
  if (pts.length < 2) return pts
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]
    const t = 0.35 + rand() * 0.3
    out.push(
      [x0 + t * (x1 - x0) + (rand() - 0.5) * amount,
       y0 + t * (y1 - y0) + (rand() - 0.5) * amount * 0.35],
      pts[i]
    )
  }
  return out
}

// Returns array of crack strand objects:
//   { pts: [[xn, yn], ...], delayMs, durationMs, width }
// xn: 0.5 = crack centre; yn: 0 = top surface, 1 = bottom of beam
// params: { depth, dev, segs, branch, speedMul }
//   depth    – main crack depth (0–1)
//   dev      – per-step deviation / lean (80%: individual crack jaggedness)
//   segs     – segment count (80%: number of fan cracks)
//   branch   – 60%: secondary offset; 80%: lateral spread at bottom (all start at xn=0.5)
//   speedMul – animation speed multiplier (higher = faster)
export function generateCrack(sandPct, seed, {
  depth    = sandPct === 0 ? 0.88 : sandPct === 20 ? 0.60 : sandPct === 40 ? 0.33 : sandPct === 60 ? 0.50 : 0.18,
  dev      = sandPct === 0 ? 0.01 : sandPct === 20 ? 0.06 : sandPct === 40 ? 0.14 : sandPct === 60 ? 0.09 : 0.07,
  segs     = sandPct === 0 ? 2    : sandPct === 20 ? 3    : sandPct === 80 ? 4    : 4,
  branch   = sandPct === 80 ? 0.10 : 0.09,
  speedMul = 1.0,
} = {}) {
  const rand = makeRand(seed)
  const r  = () => rand()
  const rn = () => rand() * 2 - 1

  function buildMain(xClamp) {
    const pts = [[0.5, 0]]
    let x = 0.5
    for (let i = 1; i <= segs; i++) {
      x += rn() * dev
      x = Math.max(xClamp, Math.min(1 - xClamp, x))
      pts.push([x, i / segs * depth])
    }
    return pts
  }

  // Returns the [x, y] point on main at fracDown * depth
  function branchAt(main, fracDown) {
    const bY = depth * fracDown
    let bx = main[0][0]
    for (let i = 1; i < main.length; i++) {
      if (main[i][1] >= bY) {
        const t = (bY - main[i - 1][1]) / (main[i][1] - main[i - 1][1])
        bx = main[i - 1][0] + t * (main[i][0] - main[i - 1][0])
        break
      }
    }
    return [bx, bY]
  }

  if (sandPct === 0) {
    return [{
      pts: jitterPath(buildMain(0.2), dev * 0.7, rand),
      delayMs: 0, durationMs: 80 / speedMul, width: 2.0, fromTop: true,
    }]
  }

  if (sandPct === 20) {
    const main = buildMain(0.3)
    const strands = [{ pts: jitterPath(main, dev * 0.2, rand), delayMs: 0, durationMs: 160 / speedMul, width: 2.0, fromTop: true }]
    if (r() < 0.8) {
      const [bx, bY] = branchAt(main, 0.42 + r() * 0.33)
      const bDir = rn() > 0 ? 1 : -1
      strands.push({
        pts: jitterPath([[bx, bY], [bx + bDir * (branch + r() * branch * 0.9), bY + depth * (0.067 + r() * 0.083)]], dev * 0.15, rand),
        delayMs: 100 / speedMul, durationMs: 60 / speedMul, width: 1.3, fromTop: false,
      })
    }
    return strands
  }

  if (sandPct === 40) {
    const main = buildMain(0.15)
    const strands = [{ pts: jitterPath(main, dev * 0.17, rand), delayMs: 0, durationMs: 220 / speedMul, width: 2.5, fromTop: true }]
    const nBranches = r() < 0.3 ? 0 : r() < 0.6 ? 1 : 2
    for (let b = 0; b < nBranches; b++) {
      const [bx, bY] = branchAt(main, 0.24 + r() * 0.55)
      const bDir = rn() > 0 ? 1 : -1
      strands.push({
        pts: jitterPath([[bx, bY], [bx + bDir * (branch + r() * branch * 0.9), bY + depth * (0.15 + r() * 0.18)]], dev * 0.08, rand),
        delayMs: (120 + b * 60) / speedMul, durationMs: 70 / speedMul, width: 1.4, fromTop: false,
      })
    }
    return strands
  }

  if (sandPct === 60) {
    const main = buildMain(0.2)
    const strands = [{ pts: jitterPath(main, dev * 0.2, rand), delayMs: 0, durationMs: 190 / speedMul, width: 2.2, fromTop: true }]
    const nSec = 1 + Math.floor(r())
    for (let s = 0; s < nSec; s++) {
      let sx = 0.5 + rn() * branch
      const sPts = [[sx, 0]]
      const snSeg = 2 + Math.floor(r())
      for (let i = 1; i <= snSeg; i++) {
        sx += rn() * dev * 0.9
        sx = Math.max(0.1, Math.min(0.9, sx))
        sPts.push([sx, i / snSeg * (depth * 0.44 + r() * depth * 0.44)])
      }
      strands.push({
        pts: jitterPath(sPts, dev * 0.15, rand),
        delayMs: (90 + s * 70) / speedMul, durationMs: 80 / speedMul, width: 1.5, fromTop: true,
      })
    }
    return strands
  }

  // 80%: cracks all start at center+10px right (xn=0.60, aligns with micro viz crack origin)
  // branch = lateral spread at bottom, dev = jaggedness along each crack
  const strands80 = Array.from({ length: segs }, (_, i) => {
    const lean = rn() * branch
    return {
      pts: jitterPath([
        [0.60, 0],
        [0.60 + lean * 0.5, depth * 0.55],
        [0.60 + lean, depth],
      ], dev, rand),
      delayMs: i * 50 / speedMul, durationMs: 50 / speedMul, width: 1.5, fromTop: true,
    }
  })
  // ~40% chance of a short branch off the first crack
  if (r() < 0.4 && strands80.length > 0) {
    const main = strands80[0].pts
    const [bx, bY] = branchAt(main, 0.3 + r() * 0.4)
    const bDir = rn() > 0 ? 1 : -1
    strands80.push({
      pts: jitterPath([[bx, bY], [bx + bDir * (branch * 0.5 + r() * branch * 0.4), bY + depth * (0.1 + r() * 0.15)]], dev * 0.5, rand),
      delayMs: 80 / speedMul, durationMs: 40 / speedMul, width: 1.1, fromTop: false,
    })
  }
  return strands80
}

export default function MacroPanel({ phase = 'idle', force = 0, onForceChange, sandPct = 40, crackPts = [], layoutSeed = 0, arrowScale = 2, capLength = 6, capAngle = 20, crackGeom = {} }) {
  const beamL  = 160
  const beamH  = 38
  const wallW  = 18
  const wallX  = 25
  const beamX  = wallX + wallW
  const tipX   = beamX + beamL
  const beamY  = 72
  const beamBotY = beamY + beamH

  const deformFactor = DEFORM[sandPct] ?? 0.80
  const maxTipDrop   = 14
  const fullDrop     = force * maxTipDrop * deformFactor
  const targetDrop   = phase === 'idle' ? 0
    : (phase === 'testing') ? fullDrop * 0.06
    : fullDrop

  const [tipDrop, setTipDrop] = useState(0)
  const animRef = useRef({ val: 0, rafId: null })

  useEffect(() => {
    cancelAnimationFrame(animRef.current.rafId)
    if (phase === 'idle' || phase === 'testing') {
      animRef.current.val = targetDrop
      setTipDrop(targetDrop)
      return
    }
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

  const maxArrowLen = 36 * arrowScale
  const arrowHeadH  = 10 * arrowScale
  const arrowHeadW  = 12 * arrowScale
  const arrowLen    = force * maxArrowLen
  const arrowTip    = topR
  const arrowBase   = arrowTip - arrowLen - arrowHeadH

  const dotFrac = 0.16
  const dotX = beamX + beamL * dotFrac
  const dotY = beamY

  const crackStrands = useMemo(
    () => generateCrack(sandPct, layoutSeed * 7919 + sandPct * 137, crackGeom),
    [sandPct, layoutSeed, crackGeom]
  )

  function strandToD(strand) {
    return strand.pts.map(([xn, yn], i) => {
      const x = (dotX + (xn - 0.5) * beamH * 0.50).toFixed(1)
      const y = Math.min(beamBotY, beamY + yn * beamH).toFixed(1)
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    }).join(' ')
  }

  const vbL = 0
  const vbR = tipX + 20
  const vbT = beamY - maxArrowLen - arrowHeadH - 10
  const vbB = beamBotY + maxTipDrop + 10
  const viewBox = `${vbL} ${vbT} ${vbR - vbL} ${vbB - vbT}`

  const forceKN   = Math.round(force * 2500)
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

        {/* Internal texture lines */}
        {[0.33, 0.67].map((t, i) => (
          <path key={i}
            d={`M ${beamX},${beamY + t * beamH} C ${cpX1},${cpTopY1 + t * (cpBotY1 - cpTopY1)} ${cpX2},${cpTopY2 + t * (cpBotY2 - cpTopY2)} ${tipX},${topR + t * beamH}`}
            stroke="#8a8278" strokeWidth={0.8} fill="none" opacity={0.4}
          />
        ))}

        {/* Force arrow */}
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

        {/* Crack strands — each with its own timing */}
        {phase === 'failed' && crackStrands.map((strand, si) => {
          const capRad = capAngle * Math.PI / 180
          const sx = dotX + (strand.pts[0][0] - 0.5) * beamH * 0.50
          const sy = beamY
          const capD = `M${sx.toFixed(1)},${sy.toFixed(1)} L${(sx + Math.sin(capRad) * capLength).toFixed(1)},${(sy - Math.cos(capRad) * capLength).toFixed(1)}`
          return [
            <path key={`cap-${si}`}
              d={capD}
              stroke="#1c1c1c" strokeWidth={strand.width * 3} fill="none"
              strokeLinecap="round"
              pathLength="1" className="crack"
              style={{ animation: 'draw-crack 50ms ease-out 0ms forwards' }}
            />,
            <path key={si}
              d={strandToD(strand)}
              stroke="#1c1c1c" strokeWidth={strand.width * 3} fill="none"
              strokeLinecap="round" strokeLinejoin="round"
              pathLength="1" className="crack"
              style={{ animation: `draw-crack ${strand.durationMs}ms ease-out ${strand.delayMs}ms forwards` }}
            />,
          ]
        })}

        {/* Red box — same 12:7 aspect ratio as micro view */}
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
