import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { generateCrack } from './MacroPanel'
import { MicroPanelB, BondIcon, buildGrains, buildBlueGrains, buildBlueCrackWaypoints, VW, VH, buildPhysics, stepPhysics, snapshotP1, MAX_PUNCH_DISP, buildIons, buildLattice, FRACTURE_THRESHOLD, FAULT_BREAK_FACTOR, strainColor, COLOR_STOPS, MATRIX_SPACING } from './MicroPanel'
import './ConcreteViewer.css'

const SAND_PRESETS = [0, 20, 40, 60, 80]
const SPEEDS = [0.25, 0.5, 1.0, 2.0, 4.0]
const MANUAL_SAND_PCT = 40
const MANUAL_FORCE_STEP = 20
const MANUAL_MAX_N = 600   // 30 steps of 20N; break at ~40% happens around 240-360N in practice
// Mean break strength (kN) and coefficient of variation per sand ratio.
// Source: Amix Systems (2026); see README for details.
const SAND_BREAK_KN  = { 0: 600, 20: 650, 40: 750, 60: 900, 80: 400 }
const SAND_BREAK_VAR = { 0: 0.40, 20: 0.20, 40: 0.10, 60: 0.10, 80: 0.10 }
// Per-mix fault bond break factor — scales how much strain fault bonds tolerate before snapping.
const SAND_FAULT_BREAK = { 0: 0.200, 20: 0.217, 40: 0.250, 60: 0.333, 80: 0.133 }
// Observed distribution of raw physics break force (internal kN) — MANUAL pre-run context.
// widthMul=SAND_KN_SCALE, isBlue=false, 600 fine steps. Calibrate via runManualTests(50).
const OBSERVED_MEAN_KN = { 0: 883, 20: 340, 40: 294, 60: 353, 80: 120 }
const OBSERVED_STD_KN  = { 0: 192, 20: 109, 40:  69, 60: 110, 80: 140 }
// Observed distribution — LIVE test context (widthMul=1, isBlue=true, +0.004/frame).
// Calibrate via runBreakTests(50) — feed the iKN mean/std columns back to update these.
const LIVE_OBSERVED_MEAN_KN = { 0: 1087, 20: 464, 40: 480, 60: 838, 80: 314 }
const LIVE_OBSERVED_STD_KN  = { 0:  249, 20: 200, 40: 208, 60: 424, 80: 170 }
// Empirical LCD scaling for rising animation (before break): internal kN → displayed kN.
const SAND_KN_SCALE = { 0: 0.552, 20: 1.401, 40: 1.563, 60: 1.074, 80: 1.274 }

function seededRandom(seed) {
  const x = Math.sin(seed * 9301 + 49297) * 233280
  return x - Math.floor(x)
}

const PHASE1_RATIO    = 1.1
const PHASE1_STEPS    = 34
const PHASE2_STEPS    = 8
const PHASE1_DURATION = 700
const PHASE2_DURATION = 80

const PZL_IMG_H = 1687   // BeamTestNoBeam natural height
const SIM_ASPECT = VW / VH

const lerp = (a, b, t) => a + (b - a) * t

const BAR_IMG_AR = 372 / 1278   // BarAlone2.png naturalHeight/naturalWidth

const CRACK_SCALE      = 7    // magnification relative to red box size
const THUMB_CRACK_SCALE = 7   // match main photo crack scale
const CRACK_Y_FAC  = 0.70  // macro renders crack at 70% of beam height
const CRACK_X_FAC  = 0.50  // macro horizontal spread factor

const BAR_SRCS = {
  0:  ['/concrete/0Sandbar.png',  null],
  20: ['/concrete/20Sandbar.png', null],
  40: ['/concrete/40Sandbar.png', null],
  60: ['/concrete/60Sandbar.png', null],
  80: ['/concrete/80Sandbar.png', null],
}

// ── Batch break-force diagnostic ──────────────────────────────────────────────
// Call window.runBreakTests(count=10) from the browser console.
// Runs physics synchronously for `count` random seeds per sand ratio.
// Outputs a console.table() of every individual result for histogram analysis,
// plus a summary line per ratio. Call e.g. runBreakTests(200).
function runBreakTests(count = 10) {
  const histRows  = []  // per-seed data for histogram overlay
  const summary   = []  // per-ratio summary for console output

  for (const pct of [0, 20, 40, 60, 80]) {
    const fbf        = SAND_FAULT_BREAK[pct] ?? FAULT_BREAK_FACTOR
    const targetMean = SAND_BREAK_KN[pct]    ?? 600
    const targetCv   = SAND_BREAK_VAR[pct]   ?? 0.10
    const obsMean    = LIVE_OBSERVED_MEAN_KN[pct] ?? 1000
    const obsStd     = LIVE_OBSERVED_STD_KN[pct]  ?? 200

    const displays   = []
    const internals  = []
    for (let i = 0; i < count; i++) {
      const seed      = Math.round(Math.random() * 1e6)
      const layoutFbf = pct === 0
        ? fbf * (1 + (seededRandom(seed) * 2 - 1) * SAND_BREAK_VAR[0])
        : fbf

      const grains   = buildGrains(pct, seed * 7919 + pct * 137 + 42)
      const ions     = buildIons(grains)
      const lattices = grains.map(buildLattice)
      const phys     = buildPhysics(ions, grains, lattices, 1, true, null, layoutFbf)

      let dispForce  = 0
      let breakForce = null
      for (let frame = 0; frame < 1000; frame++) {
        dispForce = Math.min(1.0, dispForce + 0.004)
        stepPhysics(phys, dispForce, 1, true)
        if (phys.bonds.some(b => b.broken)) { breakForce = dispForce; break }
      }

      if (breakForce != null) {
        const internalKN = breakForce * 2500
        const z          = Math.tanh((internalKN - obsMean) / obsStd)
        const displayKN  = Math.max(1, Math.round(targetMean * (1 + z * targetCv)))
        displays.push(displayKN)
        internals.push(Math.round(internalKN))
        histRows.push({ sand: `${pct}%`, seed, displayKN, internalKN: Math.round(internalKN), z: +z.toFixed(3) })
      }
    }

    const avg   = displays.length  ? Math.round(displays.reduce((a, b) => a + b) / displays.length) : null
    const minD  = displays.length  ? Math.min(...displays) : null
    const maxD  = displays.length  ? Math.max(...displays) : null
    const iMean = internals.length ? Math.round(internals.reduce((a, b) => a + b) / internals.length) : null
    const iStd  = internals.length ? Math.round(Math.sqrt(internals.map(v => (v - iMean) ** 2).reduce((a, b) => a + b) / internals.length)) : null
    summary.push({ 'sand%': `${pct}%`, min: minD, avg, max: maxD, target: targetMean, 'spec range': `${Math.round(targetMean*(1-targetCv))}–${Math.round(targetMean*(1+targetCv))}`, 'iKN mean': iMean, 'iKN std': iStd, 'const mean': obsMean })
  }

  console.table(summary)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('breakTestData', { detail: histRows }))
  return summary
}
if (typeof window !== 'undefined') window.runBreakTests = runBreakTests

// Simulates exactly what the manual mode LCD shows at break, in bulk.
// Runs the same pre-run + coarse recording loop the recording build uses,
// and reports the LCD value at foundBreakN — the number the user actually sees.
function runManualTests(count = 10) {
  const WIDTH_MULS = { 0: 2.23 * 1.5, 20: 1.8 * 1.5, 40: 1.6 * 1.5, 60: 0.7 * 1.5, 80: 6.0 * 1.5 }
  const rows = []

  for (const pct of [0, 20, 40, 60, 80]) {
    const fbf        = SAND_FAULT_BREAK[pct] ?? FAULT_BREAK_FACTOR
    const targetMean = SAND_BREAK_KN[pct]    ?? 600
    const targetCv   = SAND_BREAK_VAR[pct]   ?? 0.10
    const obsMean    = OBSERVED_MEAN_KN[pct]  ?? 1000
    const obsStd     = OBSERVED_STD_KN[pct]   ?? 200
    const widthMul   = WIDTH_MULS[pct] ?? 2.4

    const displays = []
    const internals = []
    for (let i = 0; i < count; i++) {
      const seed      = Math.round(Math.random() * 1e6)
      const manualFbf = pct === 0
        ? fbf * (1 + (seededRandom(seed) * 2 - 1) * SAND_BREAK_VAR[0])
        : fbf

      const grains   = buildGrains(pct, seed * 7919 + pct * 137 + 42)
      const ions     = buildIons(grains)
      const lattices = grains.map(buildLattice)

      // Step 1: fine pre-run (all ratios), same as recording build
      const physPre = buildPhysics(ions, grains, lattices, widthMul, false, null, manualFbf)
      let preBreakN = null
      for (let n = 1; n <= MANUAL_MAX_N; n++) {
        const f = n / MANUAL_MAX_N
        physPre.currentDisp = f * MAX_PUNCH_DISP
        stepPhysics(physPre, f, 1, true)
        if (physPre.bonds.some(b => b.broken)) { preBreakN = n; break }
      }
      if (preBreakN == null) continue

      const internalKN      = (preBreakN / MANUAL_MAX_N) * 2500
      const z               = Math.tanh((internalKN - obsMean) / obsStd)
      const targetDisplayKN = Math.max(1, targetMean * (1 + z * targetCv))
      const effectiveScale  = targetDisplayKN * MANUAL_MAX_N / (2500 * preBreakN)

      // Step 2: coarse recording loop (same step size as button presses)
      const phys       = buildPhysics(ions, grains, lattices, widthMul, false, null, manualFbf)
      const manualStep = 20 * MANUAL_MAX_N / (2500 * effectiveScale)
      let foundBreakN  = null
      for (let n = 0; n <= MANUAL_MAX_N; n += manualStep) {
        const f = n / MANUAL_MAX_N
        phys.currentDisp = f * MAX_PUNCH_DISP
        stepPhysics(phys, f, 1, true)
        if (foundBreakN === null && phys.bonds.some(b => b.broken)) { foundBreakN = n; break }
      }
      if (foundBreakN == null) continue

      displays.push(Math.round((foundBreakN / MANUAL_MAX_N) * 2500 * effectiveScale))
      internals.push(Math.round(internalKN))
    }

    const avg   = displays.length ? Math.round(displays.reduce((a, b) => a + b) / displays.length) : null
    const minD  = displays.length ? Math.min(...displays) : null
    const maxD  = displays.length ? Math.max(...displays) : null
    const iMean = internals.length ? Math.round(internals.reduce((a, b) => a + b) / internals.length) : null
    const iStd  = internals.length > 1
      ? Math.round(Math.sqrt(internals.map(v => (v - iMean) ** 2).reduce((a, b) => a + b) / (internals.length - 1)))
      : null
    rows.push({ 'sand%': `${pct}%`, min: minD, avg, max: maxD, target: targetMean, 'spec range': `${Math.round(targetMean*(1-targetCv))}–${Math.round(targetMean*(1+targetCv))}`, 'iKN mean': iMean, 'iKN std': iStd, 'const mean': obsMean })
  }

  console.table(rows)
  return rows
}
if (typeof window !== 'undefined') window.runManualTests = runManualTests

// Renders bar image with a quadratic downward bend. Optionally blends a second
// image at 50% opacity for intermediate sand percentages.
// bend = right-edge drop as a fraction of the image's natural height.
// Left edge is pinned at y=0; each column x shifts down by bend*H*(x/W)^2.
function BentBar({ src, src2 = null, bend = 0, style }) {
  const canvasRef = useRef(null)
  const [img,  setImg]  = useState(null)
  const [img2, setImg2] = useState(null)

  useEffect(() => {
    const el = new Image()
    el.onload = () => setImg(el)
    el.src = src
  }, [src])

  useEffect(() => {
    if (!src2) { setImg2(null); return }
    const el = new Image()
    el.onload = () => setImg2(el)
    el.src = src2
  }, [src2])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !img) return
    const W = img.naturalWidth
    const H = img.naturalHeight
    const dropPx = bend * H
    canvas.width  = W
    canvas.height = H + Math.ceil(dropPx) + 1
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (let x = 0; x < W; x++) {
      const t = x / Math.max(W - 1, 1)
      ctx.drawImage(img, x, 0, 1, H, x, dropPx * t * t, 1, H)
    }
    if (img2) {
      ctx.globalAlpha = 0.5
      for (let x = 0; x < W; x++) {
        const t = x / Math.max(W - 1, 1)
        ctx.drawImage(img2, x, 0, 1, H, x, dropPx * t * t, 1, H)
      }
      ctx.globalAlpha = 1
    }
  }, [img, img2, bend])

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: 'auto', ...style }} />
}

// Copies the sim canvas into the box, cropped to the xMidYMid-meet content area
// so transparent letterbox strips don't show through as cream.
function SimThumb({ srcRef, opacity = 1 }) {
  const thumbRef = useRef(null)
  useEffect(() => {
    let rafId
    function tick() {
      const src = srcRef.current?.querySelector('canvas')
      const dst = thumbRef.current
      if (src && dst && src.width > 0 && src.height > 0) {
        const ctx = dst.getContext('2d')
        ctx.clearRect(0, 0, dst.width, dst.height)
        const bW = src.width, bH = src.height
        const sc = Math.min(bW / VW, bH / VH)
        const ox = (bW - VW * sc) / 2
        const oy = (bH - VH * sc) / 2
        ctx.drawImage(src, ox, oy, VW * sc, VH * sc, 0, 0, dst.width, dst.height)
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [srcRef])
  return (
    <canvas
      ref={thumbRef}
      width={VW}
      height={VH}
      style={{ display: 'block', width: '100%', height: '100%', opacity }}
    />
  )
}

const THUMB_W = 20

function ScrubSlider({ value, onChange, disabled }) {
  const trackRef  = useRef(null)
  const dragging  = useRef(false)
  const onChangeCb = useRef(onChange)
  useEffect(() => { onChangeCb.current = onChange }, [onChange])

  useEffect(() => {
    function onMove(e) {
      if (!dragging.current || !trackRef.current) return
      const rect = trackRef.current.getBoundingClientRect()
      onChangeCb.current(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
    }
    function onUp() {
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  function onMouseDown(e) {
    if (disabled || !trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    onChangeCb.current(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
    dragging.current = true
    document.body.style.cursor = 'grabbing'
    e.preventDefault()
  }

  const pct = `${value * 100}%`
  return (
    <div
      ref={trackRef}
      onMouseDown={onMouseDown}
      style={{
        position: 'relative', flex: 1, height: 30,
        display: 'flex', alignItems: 'center',
        opacity: disabled ? 0.32 : 1,
        userSelect: 'none',
      }}
    >
      {/* Groove */}
      <div style={{
        position: 'absolute', left: 0, right: 0, height: 5, borderRadius: 3,
        background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(18,12,6,0.70) 100%)',
        boxShadow: 'inset 0 2px 3px rgba(0,0,0,0.65), inset 0 -1px 0 rgba(255,255,255,0.04)',
      }} />
      {/* Fill */}
      <div style={{
        position: 'absolute', left: 0, width: pct, height: 5, borderRadius: 3,
        background: 'linear-gradient(180deg, rgba(180,138,72,0.50) 0%, rgba(130,96,44,0.32) 100%)',
        pointerEvents: 'none',
      }} />
      {/* Thumb */}
      <div style={{
        position: 'absolute', left: pct,
        transform: 'translateX(-50%)',
        width: THUMB_W, height: 30, borderRadius: 4,
        background: 'linear-gradient(180deg, #5c5040 0%, #3e3428 52%, #2c2418 100%)',
        border: '1px solid rgba(160,130,80,0.32)',
        boxShadow: [
          'inset 0 1px 0 rgba(220,190,130,0.16)',
          'inset 0 -1px 0 rgba(0,0,0,0.55)',
          '0 0 0 1px rgba(0,0,0,0.65)',
          '0 3px 5px rgba(0,0,0,0.65)',
          '0 6px 12px rgba(0,0,0,0.38)',
        ].join(', '),
        cursor: disabled ? 'default' : 'grab',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 3.5,
        zIndex: 1, pointerEvents: 'none',
      }}>
        {[0,1,2,3].map(i => (
          <div key={i} style={{
            width: 10, height: 1.5, borderRadius: 1,
            background: 'rgba(200,170,100,0.30)',
          }} />
        ))}
      </div>
    </div>
  )
}

const GREY_Y_EXTRA = 11  // zoom-layer % offset — grey box is this far below the red box

function ZoomHint({ x, y, color, circleSize, textBelow = false, extraUp = 0, onClick = null, cursor = 'zoom-in', circleDx = 0, circleDy = 0, textDx = 0, textDy = 0 }) {
  const fontSize = Math.max(8, circleSize * 0.52 - 1)
  const gap = circleSize / 2 + 4
  const circleTransform = (circleDx || circleDy)
    ? `translate(calc(-50% + ${circleDx}px), calc(-50% + ${circleDy}px))`
    : 'translate(-50%, -50%)'
  const textTransform = textBelow
    ? `translate(calc(-50% + ${textDx}px), calc(50% + ${gap + textDy}px))`
    : `translate(calc(-50% + ${textDx}px), calc(-50% - ${gap + extraUp - textDy}px))`
  return (
    <>
      <div onClick={onClick} style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        width: circleSize,
        height: circleSize,
        borderRadius: '50%',
        background: color,
        opacity: 0.38,
        transform: circleTransform,
        pointerEvents: onClick ? 'auto' : 'none',
        cursor: onClick ? cursor : undefined,
        userSelect: 'none',
        zIndex: 25,
      }} />
      <div style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        transform: textTransform,
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 25,
        color,
        fontSize,
        fontWeight: 700,
        letterSpacing: '0.10em',
        lineHeight: 1,
        opacity: 0.85,
        fontFamily: 'system-ui, sans-serif',
        whiteSpace: 'nowrap',
      }}>ZOOM</div>
    </>
  )
}

function PhotoScene({
  cropFrac,
  sandPct, barX, barY, barSize, bend,
  macroCrackStrands, currentCrackParams,
  photoBoxX, boxW, boxH,
  crackScale,
  scrubElapsed,
  pusherX, pusherY, pusherNudgePct = 0,
  pusherSize,
  lcdX, lcdY, lcdKN, containerW, lcdNudge = { dx: 0, dy: 0 },
  showPhotoCracks, showBlueCrack, photoViewIsZooming,
  photoBoxY, blueBoxPos, greyBoxX,
  borderPx,
  effectivePhotoScale,
  photoBoxHovered = false, onPhotoBoxHover = null,
  blueBoxHovered = false, onBlueBoxHover = null,
  effectiveBoxBgAlpha = 0,
  photoBoxRef = null, photoBoxContent = null,
  onBoxClick,
  capLength, capAngle,
  boxCursor = 'zoom-in',
  showZoomUI = true,
  circleScale = 1,
  hintNudges = {},
}) {
  const crackOriginY = photoBoxY
  const circleSize = containerW * 2.5 * circleScale * boxW / 100

  function strandToCapD(strand) {
    const [xn0] = strand.pts[0]
    const px0 = photoBoxX + (xn0 - 0.5) * CRACK_X_FAC * boxW * crackScale
    const py0 = crackOriginY
    const capRad = capAngle * Math.PI / 180
    const capScaleF = CRACK_Y_FAC * crackScale * boxH / 38
    const pex = px0 + Math.sin(capRad) * capLength * capScaleF
    const pey = py0 - Math.cos(capRad) * capLength * capScaleF
    return `M${px0.toFixed(2)},${py0.toFixed(2)} L${pex.toFixed(2)},${pey.toFixed(2)}`
  }

  function strandToCapTipD(strand, wm) {
    const [xn0] = strand.pts[0]
    const px0 = photoBoxX + (xn0 - 0.5) * CRACK_X_FAC * boxW * crackScale
    const py0 = crackOriginY
    const capRad = capAngle * Math.PI / 180
    const capScaleF = CRACK_Y_FAC * crackScale * boxH / 38
    const pex = px0 + Math.sin(capRad) * capLength * capScaleF
    const pey = py0 - Math.cos(capRad) * capLength * capScaleF
    const sinC = Math.sin(capRad), cosC = Math.cos(capRad)
    const hw = 0.125 * wm
    const h  = wm * 1.5
    const tw = hw * 0.18
    const f  = n => n.toFixed(2)
    return `M${f(pex - cosC*hw)},${f(pey - sinC*hw)} ` +
           `L${f(pex + cosC*hw)},${f(pey + sinC*hw)} ` +
           `L${f(pex + sinC*h + cosC*tw)},${f(pey - cosC*h + sinC*tw)} ` +
           `L${f(pex + sinC*h - cosC*tw)},${f(pey - cosC*h - sinC*tw)} Z`
  }

  const wm = currentCrackParams.widthMul
  const tp = currentCrackParams.taper

  return (
    <>
      <img src="/concrete/BeamTestNoBeam.png" draggable={false} style={{
        display: 'block', width: '100%', height: 'auto', userSelect: 'none',
        transform: `translateY(-${cropFrac * 100}%)`,
      }} />
      <BentBar
        src={BAR_SRCS[sandPct][0]} src2={BAR_SRCS[sandPct][1]}
        bend={bend}
        style={{ position: 'absolute', left: `${barX}%`, top: `${barY}%`, width: `${barSize}%`, pointerEvents: 'none', userSelect: 'none' }}
      />
      {showPhotoCracks && (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
        >
          {macroCrackStrands.flatMap((strand, si) => {
            const photoPts = strand.pts.map(([xn, yn]) => [
              photoBoxX + (xn - 0.5) * CRACK_X_FAC * boxW * crackScale,
              crackOriginY + yn * CRACK_Y_FAC * boxH * crackScale,
            ])
            const N = photoPts.length - 1
            return [
              ...(strand.fromTop ? [
                <path key={`${si}-cap`} d={strandToCapD(strand)}
                  fill="none" stroke="#1a1008" strokeWidth={0.3 * wm} strokeLinecap="butt"
                  style={{ opacity: scrubElapsed != null && scrubElapsed <= strand.delayMs ? 0 : 1 }} />,
                <path key={`${si}-captip`} d={strandToCapTipD(strand, wm)} fill="#f5f0e8" stroke="none"
                  style={{ opacity: scrubElapsed != null && scrubElapsed <= strand.delayMs ? 0 : 1 }} />,
              ] : []),
              ...photoPts.slice(0, -1).map(([px0, py0], i) => {
                const [px1, py1] = photoPts[i + 1]
                const t = N <= 1 ? 0 : i / (N - 1)
                const w = 0.25 * wm * Math.max(0.03, 1 + tp * t)
                const segDur = strand.durationMs / N
                const segDelay = strand.delayMs + i * segDur
                const d = `M${px0.toFixed(2)},${py0.toFixed(2)} L${px1.toFixed(2)},${py1.toFixed(2)}`
                const pathStyle = scrubElapsed != null
                  ? { strokeDasharray: 1, strokeDashoffset: 1 - Math.max(0, Math.min(1, (scrubElapsed - segDelay) / segDur)) }
                  : { animation: `draw-crack ${segDur}ms ease-out ${segDelay}ms forwards` }
                return <path key={`${si}-${i}`} d={d} pathLength="1" className="crack"
                  fill="none" stroke="#1a1008" strokeWidth={w} strokeLinecap="round" style={pathStyle} />
              }),
            ]
          })}
        </svg>
      )}
      <img src="/concrete/Pusher.png" draggable={false} style={{
        position: 'absolute',
        left: `${pusherX}%`,
        top: `${pusherY + pusherNudgePct}%`,
        width: `${pusherSize}%`,
        height: 'auto',
        transform: 'translateX(-50%)',
        pointerEvents: 'none', userSelect: 'none',
      }} />
      <div style={{
        position: 'absolute', left: `${lcdX}%`, top: `${lcdY}%`,
        transform: `translate(calc(-50% + ${lcdNudge.dx}px), calc(-50% + ${lcdNudge.dy}px)) rotate(3deg)`, zIndex: 20,
        pointerEvents: 'none', userSelect: 'none',
        fontFamily: '"DSEG7", "Courier New", monospace',
        fontSize: containerW * 0.0202,
        letterSpacing: '0.05em',
        lineHeight: 1,
        width: containerW * 0.086,
      }}>
        <span style={{ color: 'rgba(60,60,60,0.18)', position: 'absolute', inset: 0, textAlign: 'right', userSelect: 'none' }}>8888</span>
        <span style={{ color: 'rgba(60,60,60,0.72)', display: 'block', textAlign: 'right' }}>{Math.round(lcdKN)}</span>
      </div>
      {!photoViewIsZooming && showZoomUI && (
        <>
          <div
            ref={photoBoxRef}
            className="photo-box"
            style={{
              left: `${photoBoxX - boxW / 2}%`,
              top: `${crackOriginY}%`,
              width: `${boxW}%`,
              height: `${boxH}%`,
              background: `rgba(245,240,232,${effectiveBoxBgAlpha})`,
              borderWidth: `${borderPx}px`,
              borderColor: photoBoxHovered ? '#ff4444' : '#cc2222',
              boxShadow: photoBoxHovered
                ? `0 0 0 ${1/effectivePhotoScale}px rgba(0,0,0,0.6), 0 0 ${16/effectivePhotoScale}px rgba(200,30,30,0.9)`
                : `0 0 0 ${1/effectivePhotoScale}px rgba(0,0,0,0.6), 0 0 ${8/effectivePhotoScale}px rgba(200,30,30,0.5)`,
              pointerEvents: photoViewIsZooming ? 'none' : 'auto',
              cursor: boxCursor,
            }}
            onMouseEnter={() => onPhotoBoxHover?.(true)}
            onMouseLeave={() => onPhotoBoxHover?.(false)}
            onClick={e => { e.stopPropagation(); onBoxClick?.('red') }}
          >
            {photoBoxContent}
          </div>
          <ZoomHint
            x={photoBoxX}
            y={crackOriginY + boxH / 2}
            color="#cc2222"
            circleSize={circleSize}
            extraUp={20}
            onClick={e => { e.stopPropagation(); onBoxClick?.('red') }}
            cursor={boxCursor}
            circleDx={hintNudges.red?.circleDx ?? 0}
            circleDy={hintNudges.red?.circleDy ?? 0}
            textDx={hintNudges.red?.textDx ?? 0}
            textDy={hintNudges.red?.textDy ?? 0}
          />
        </>
      )}
      {showBlueCrack && showZoomUI && (
        <>
          <div
            className="photo-box"
            style={{
              left: `${blueBoxPos.x - boxW / 2}%`,
              top: `${blueBoxPos.y - boxH / 2}%`,
              width: `${boxW}%`,
              height: `${boxH}%`,
              background: 'none',
              borderWidth: `${borderPx}px`,
              borderColor: blueBoxHovered ? '#4499ff' : '#2266cc',
              boxShadow: blueBoxHovered
                ? `0 0 0 ${1/effectivePhotoScale}px rgba(0,0,0,0.6), 0 0 ${16/effectivePhotoScale}px rgba(30,100,220,0.9)`
                : `0 0 0 ${1/effectivePhotoScale}px rgba(0,0,0,0.6), 0 0 ${8/effectivePhotoScale}px rgba(30,100,220,0.5)`,
              pointerEvents: photoViewIsZooming ? 'none' : 'auto',
              cursor: boxCursor,
            }}
            onMouseEnter={() => onBlueBoxHover?.(true)}
            onMouseLeave={() => onBlueBoxHover?.(false)}
            onClick={e => { e.stopPropagation(); onBoxClick?.('blue') }}
          />
          <ZoomHint
            x={blueBoxPos.x}
            y={blueBoxPos.y}
            color="#2266cc"
            circleSize={circleSize}
            textBelow
            onClick={e => { e.stopPropagation(); onBoxClick?.('blue') }}
            cursor={boxCursor}
            circleDx={hintNudges.blue?.circleDx ?? 0}
            circleDy={hintNudges.blue?.circleDy ?? 0}
            textDx={hintNudges.blue?.textDx ?? 0}
            textDy={hintNudges.blue?.textDy ?? 0}
          />
        </>
      )}
      {!photoViewIsZooming && showZoomUI && (
        <>
          <div
            className="photo-box"
            style={{
              left: `${greyBoxX - boxW / 2}%`,
              top: `${crackOriginY + GREY_Y_EXTRA}%`,
              width: `${boxW}%`,
              height: `${boxH}%`,
              background: 'none',
              borderWidth: `${borderPx}px`,
              borderColor: '#111111',
              boxShadow: `0 0 0 ${1/effectivePhotoScale}px rgba(0,0,0,0.5), 0 0 ${6/effectivePhotoScale}px rgba(0,0,0,0.5)`,
              pointerEvents: 'auto',
              cursor: boxCursor,
            }}
            onClick={e => { e.stopPropagation(); onBoxClick?.('grey') }}
          />
          <ZoomHint
            x={greyBoxX}
            y={crackOriginY + GREY_Y_EXTRA + boxH / 2}
            color="#111111"
            circleSize={circleSize}
            textBelow
            onClick={e => { e.stopPropagation(); onBoxClick?.('grey') }}
            cursor={boxCursor}
            circleDx={hintNudges.grey?.circleDx ?? 0}
            circleDy={hintNudges.grey?.circleDy ?? 0}
            textDx={hintNudges.grey?.textDx ?? 0}
            textDy={hintNudges.grey?.textDy ?? 0}
          />
        </>
      )}
    </>
  )
}


export default function ConcreteViewer() {
  const [sandPct, setSandPct] = useState(40)
  const [phase, setPhase]     = useState('idle')
  const [force, setForce]     = useState(1)
  const [layoutSeed, setLayoutSeed] = useState(() => Math.round(Math.random() * 1e6))
  const [speedIdx, setSpeedIdx]     = useState(2)
  const [controlTab, setControlTab] = useState('ratio')
  const [manualForceN, setManualForceN] = useState(0)
  const [manualRecording, setManualRecording] = useState(null)  // preloaded recording for manual tab
  const [manualBreakN, setManualBreakN] = useState(null)        // forceN at first fault bond break
  const [manualPhysBase, setManualPhysBase] = useState(null)    // rest-position particles + bond connectivity
  const [manualP2T, setManualP2T] = useState(0)                 // 0→1 progress of spring-back auto-play

  const [bondRound]  = useState(3)
  const [hasRecording, setHasRecording] = useState(false)
  const [scrubT, setScrubT]             = useState(1)

  // Test scrub: checkbox shows/hides the replay slider
  const [showDevSliders, setShowDevSliders] = useState(false)
  const [histRows,           setHistRows]           = useState(null)
  const [histSandPct,        setHistSandPct]        = useState(0)
  const [manualEffectiveScale, setManualEffectiveScale] = useState(null)
  const [zoomScrubT,  setZoomScrubT]  = useState(0)
  const [breakKN, setBreakKN] = useState(null)
  const [liveDispForce, setLiveDispForce] = useState(0)
  const [lcdX, setLcdX] = useState(73.8)
  const [lcdY, setLcdY] = useState(13)
  const [capLength, setCapLength] = useState(10.5)
  const [capAngle,  setCapAngle]  = useState(33)
  const [p2StartFrac, setP2StartFrac] = useState(null)
  const [crackParams, setCrackParams] = useState({
    0:  { depth: 1.31, dev: 0.00, segs: 1, branch: 0.03, widthMul: 2.23, speedMul: 1.0, taper: -0.25 },
    20: { depth: 1.31, dev: 0.140, segs: 1, branch: 0.14, widthMul: 1.8, speedMul: 2.9, taper: -0.55 },
    40: { depth: 0.67, dev: 0.565, segs: 1, branch: 0.13, widthMul: 1.6, speedMul: 1.0, taper: -0.45 },
    60: { depth: 0.6, dev: 0.21, segs: 1, branch: 0.83, widthMul: 0.7, speedMul: 1.0, taper: -0.5 },
    80: { depth: 1.31, dev: 0.43, segs: 1, branch: 0.77, widthMul: 6.0, speedMul: 1.7, taper: -0.6 },
  })
  function setCK(key, val) {
    setCrackParams(p => ({ ...p, [sandPct]: { ...p[sandPct], [key]: val } }))
  }

  // Bend animation: 1 at idle (slider previews max), ramps 0→1 during testing
  const [bendAnim, setBendAnim] = useState(1)
  const bendRafRef = useRef(null)

  useEffect(() => {
    cancelAnimationFrame(bendRafRef.current)
    if (phase === 'testing') {
      setBendAnim(0)
      const startTime = performance.now()
      const rampMs = 2000 / SPEEDS[speedIdx]
      function tick(now) {
        const t = Math.min((now - startTime) / rampMs, 1)
        setBendAnim(t)
        if (t < 1) bendRafRef.current = requestAnimationFrame(tick)
      }
      bendRafRef.current = requestAnimationFrame(tick)
    } else if (phase === 'idle') {
      setBendAnim(0)
    } else {
      // failed / settled — snap to full
      setBendAnim(1)
    }
    return () => cancelAnimationFrame(bendRafRef.current)
  }, [phase])


  // Overlay image positioning
  const [pusherX,    setPusherX]    = useState(75.3)
  const [pusherY,    setPusherY]    = useState(-15.5)
  const [pusherSize, setPusherSize] = useState(27)
  const [barX,       setBarX]       = useState(21.9)
  const [barY,       setBarY]       = useState(8.6)
  const [barSize,    setBarSize]    = useState(70.4)

  const [showField, setShowField] = useState(true)
  const [showCount, setShowCount] = useState(false)
  const [chargeVisible, setChargeVisible] = useState(false)
  const [darkMode, setDarkMode] = useState(true)
  const [bondCounts, setBondCounts] = useState(null)
  const [initialBondCounts, setInitialBondCounts] = useState(null)

  const [photoView, setPhotoView] = useState('off')
  const [photoBoxX]    = useState(34.8)
  const [photoBoxY]    = useState(22.0)
  const [photoVShift, setPhotoVShift] = useState(17)
  const [photoBoxSize] = useState(0.25)

  const [photoScale,  setPhotoScale]  = useState(1)
  const [phase1Step,  setPhase1Step]  = useState(0)
  const [phase2Step,  setPhase2Step]  = useState(0)
  const [phase2Active, setPhase2Active] = useState(false)
  const [simReady,     setSimReady]     = useState(false)

  const [boxHovered, setBoxHovered] = useState(false)
  const [activeBox, setActiveBox] = useState('red')
  const [blueBoxHovered, setBlueBoxHovered] = useState(false)

  const microSquareRef = useRef(null)
  const blueSquareRef  = useRef(null)

  // Blue view — separate state, runs alongside red
  const [bluePhase,        setBluePhase]        = useState('idle')
  const [blueLayoutSeed,   setBlueLayoutSeed]   = useState(() => Math.round(Math.random() * 1e6))
  const [blueHasRecording, setBlueHasRecording] = useState(false)
  const [greyLayoutSeed,   setGreyLayoutSeed]   = useState(() => Math.round(Math.random() * 1e6))
  const photoStageRef  = useRef(null)
  const photoBoxRef    = useRef(null)
  const zoomLayerRef   = useRef(null)
  const [zoomLayerW,   setZoomLayerW] = useState(800)
  const miniPhotoRef   = useRef(null)
  const [miniPhotoW,   setMiniPhotoW] = useState(308)

  // Apply dark/light mode to body and root element
  useEffect(() => {
    document.body.style.background = darkMode ? '#080808' : '#e8e3da'
    document.body.setAttribute('data-theme', darkMode ? 'dark' : 'light')
    return () => { document.body.removeAttribute('data-theme') }
  }, [darkMode])

  // Re-attach ResizeObserver whenever photo-zoom-layer mounts/unmounts (photoView changes)
  useEffect(() => {
    const el = zoomLayerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setZoomLayerW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [photoView])

  useEffect(() => {
    const el = miniPhotoRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setMiniPhotoW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const zoomTimerRef   = useRef(null)
  const p2TimerRef     = useRef(null)
  const replayRef      = useRef(false)
  const blueReplayRef  = useRef(false)
  const replayRafRef   = useRef(null)
  const breakFiredRef  = useRef(false)

  function cancelZoom() {
    clearTimeout(zoomTimerRef.current)
    clearTimeout(p2TimerRef.current)
    setPhotoView('off')
    setPhotoScale(1)
    setPhase1Step(0)
    setPhase2Step(0)
    setPhase2Active(false)
  }

  function zoomOut() {
    setPhotoView('full')
    setPhotoScale(1)
    setPhase1Step(0)
    setSimReady(false)
  }

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') cancelZoom() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    let buf = ''
    const handler = e => {
      if (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return
      buf = (buf + e.key.toLowerCase()).slice(-3)
      if (buf === 'dev') { setShowDevSliders(d => !d); buf = '' }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const handler = e => setHistRows(e.detail)
    window.addEventListener('breakTestData', handler)
    return () => window.removeEventListener('breakTestData', handler)
  }, [])

  useEffect(() => {
    if (phase === 'idle' && replayRef.current) {
      replayRef.current = false
      const id = requestAnimationFrame(() => setPhase('testing'))
      return () => cancelAnimationFrame(id)
    }
  }, [phase])

  useEffect(() => {
    if (bluePhase === 'idle' && blueReplayRef.current) {
      blueReplayRef.current = false
      const id = requestAnimationFrame(() => setBluePhase('testing'))
      return () => cancelAnimationFrame(id)
    }
  }, [bluePhase])


  const isManual = controlTab === 'manual'
  const panelSandPct = sandPct
  const manualNormForce = manualForceN / MANUAL_MAX_N

  const grains = useMemo(
    () => buildGrains(panelSandPct, layoutSeed * 7919 + panelSandPct * 137 + 42),
    [panelSandPct, layoutSeed]
  )
  const blueGrains = useMemo(
    () => buildBlueGrains(panelSandPct, blueLayoutSeed * 7919 + panelSandPct * 137 + 42),
    [panelSandPct, blueLayoutSeed]
  )
  const blueCrackWaypoints = useMemo(() => buildBlueCrackWaypoints(blueGrains), [blueGrains])

  const currentCrackParams = crackParams[panelSandPct] ?? crackParams[40]
  const redP2DispScale = currentCrackParams.widthMul * 1.5
  const macroCrackStrands = useMemo(
    () => generateCrack(panelSandPct, layoutSeed * 7919 + panelSandPct * 137, currentCrackParams),
    [panelSandPct, layoutSeed, currentCrackParams]
  )
  const totalCrackMs = macroCrackStrands.reduce((m, s) => Math.max(m, s.delayMs + s.durationMs), 0)

  // Build manual-tab preload: run physics at each 20N step, snapshot, no live loop needed
  useEffect(() => {
    if (controlTab !== 'manual') { setManualEffectiveScale(null); return }
    setManualRecording(null)
    setManualBreakN(null)
    setManualForceN(0)

    const g = buildGrains(sandPct, layoutSeed * 7919 + sandPct * 137 + 42)
    const ions = buildIons(g)
    const lattices = g.map(buildLattice)
    const manualFbf = sandPct === 0
      ? (SAND_FAULT_BREAK[0] ?? FAULT_BREAK_FACTOR) * (1 + (seededRandom(layoutSeed) * 2 - 1) * SAND_BREAK_VAR[0])
      : (SAND_FAULT_BREAK[sandPct] ?? FAULT_BREAK_FACTOR)
    const widthMul = (crackParams[sandPct] ?? crackParams[40]).widthMul * 1.5
    const phys = buildPhysics(ions, g, lattices, widthMul, false, null, manualFbf)

    // Fine pre-run for all ratios: find exact break point, then back-calculate effectiveScale
    // so each button press shows exactly 20 kN and the LCD lands at the z-score-remapped target.
    let effectiveScale = SAND_KN_SCALE[sandPct] ?? 0.381
    {
      const physPre = buildPhysics(ions, g, lattices, widthMul, false, null, manualFbf)
      let preBreakN = null
      for (let n = 1; n <= MANUAL_MAX_N; n++) {
        const f = n / MANUAL_MAX_N
        physPre.currentDisp = f * MAX_PUNCH_DISP
        stepPhysics(physPre, f, 1, true)
        if (physPre.bonds.some(b => b.broken)) { preBreakN = n; break }
      }
      if (preBreakN != null) {
        const internalKN      = (preBreakN / MANUAL_MAX_N) * 2500
        const z               = Math.tanh((internalKN - (OBSERVED_MEAN_KN[sandPct] ?? 1000)) / (OBSERVED_STD_KN[sandPct] ?? 200))
        const targetDisplayKN = Math.max(1, (SAND_BREAK_KN[sandPct] ?? 600) * (1 + z * (SAND_BREAK_VAR[sandPct] ?? 0.10)))
        effectiveScale        = targetDisplayKN * MANUAL_MAX_N / (2500 * preBreakN)
      }
    }
    setManualEffectiveScale(effectiveScale)

    const recording = []
    let foundBreakN = null

    const manualStep = 20 * MANUAL_MAX_N / (2500 * effectiveScale)
    for (let n = 0; n <= MANUAL_MAX_N; n += manualStep) {
      const f = n / MANUAL_MAX_N
      // Pre-set displacement so stepPhysics doesn't ramp — it runs kinematic + relaxation instantly
      phys.currentDisp = f * MAX_PUNCH_DISP
      stepPhysics(phys, f, 1, true)

      if (foundBreakN === null && phys.bonds.some(b => b.broken)) foundBreakN = n

      const snap = snapshotP1(phys, 0, 0)
      snap.forceN = n
      recording.push(snap)

      if (foundBreakN !== null) break  // stop at first break; spring-back handles the rest
    }

    // Crack-open frames — same format as the ratio-tab break handler so drawPhase2Scene is used
    for (let i = 0; i <= 40; i++) {
      recording.push({ type: 'p2', p2Progress: i / 40 })
    }

    setManualP2T(0)  // reset auto-play on recording rebuild

    const lcdAtBreak = foundBreakN != null
      ? Math.round((foundBreakN / MANUAL_MAX_N) * 2500 * effectiveScale)
      : null
    console.log(`[MANUAL 0% REC] seed=${layoutSeed} manualStep=${(20 * MANUAL_MAX_N / (2500 * effectiveScale)).toFixed(3)} foundBreakN=${foundBreakN != null ? foundBreakN.toFixed(2) : 'NULL'} LCD_at_break=${lcdAtBreak} recording.length=${recording.length}`)

    setManualPhysBase({
      particles: phys.particles.map(p => ({ x0: p.x0, y0: p.y0, r: p.r, type: p.type, isGrain: p.isGrain })),
      bonds: phys.bonds.map(b => ({ i: b.i, j: b.j, type: b.type, diagonal: b.diagonal, isFault: b.isFault, breakStrain: b.breakStrain })),
      crackWaypoints: phys.crackWaypoints,
    })
    setManualRecording(recording)
    setManualBreakN(foundBreakN)
  }, [controlTab, layoutSeed])  // eslint-disable-line react-hooks/exhaustive-deps

  const p2Duration = 833  // ms — matches live Phase 2 P2_DURATION

  // Auto-play spring-back animation when manual force crosses break threshold
  const manualInP2 = isManual && manualBreakN != null && manualForceN >= manualBreakN
  useEffect(() => {
    if (!manualInP2) { setManualP2T(0); return }  // reset when force drops below break
    if (manualP2T >= 1) return
    const startTime = performance.now()
    let raf
    function tick() {
      const t = Math.min(1, (performance.now() - startTime) / p2Duration)
      setManualP2T(t)
      if (t < 1) raf = requestAnimationFrame(tick)
      else setScrubT(1)   // hand off to main scrubber when done
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [manualInP2, p2Duration])  // eslint-disable-line react-hooks/exhaustive-deps

  const activeHasRecording = activeBox === 'blue' ? blueHasRecording : (hasRecording || (manualInP2 && manualP2T >= 1))
  const activeIsRunning    = activeBox === 'blue'
    ? (bluePhase === 'idle' || bluePhase === 'testing')
    : (phase === 'idle' || phase === 'testing')
  const isScrubbable = (photoView === 'off' || photoView === 'full') && (!isManual ? hasRecording : (manualInP2 && manualP2T >= 1))

  // Manual mode: compute scrubT into the preloaded recording
  const manualScrubT = useMemo(() => {
    if (controlTab !== 'manual' || !manualRecording?.length) return 0
    // Phase 1 frames have forceN set; spring-back frames don't
    const p1Count = manualRecording.filter(s => s.forceN != null).length
    const totalFrames = manualRecording.length
    const p2Count = totalFrames - p1Count
    if (manualBreakN == null || manualForceN < manualBreakN) {
      // Phase 1: force wiper — button position maps to strained frame
      const scale = manualEffectiveScale ?? (SAND_KN_SCALE[sandPct] ?? 0.381)
      const idx = Math.min(Math.round(manualForceN * 2500 * scale / (20 * MANUAL_MAX_N)), p1Count - 1)
      return idx / (totalFrames - 1)
    } else {
      // Phase 2: auto-play drives the frame; manualP2T stays at 1 when done
      const p2Idx = Math.round(manualP2T * (p2Count - 1))
      const frameIdx = p1Count + p2Idx
      return Math.min(1, frameIdx / (totalFrames - 1))
    }
  }, [controlTab, manualRecording, manualForceN, manualBreakN, manualP2T, manualEffectiveScale])

  const manualP2StartFrac = useMemo(() => {
    if (!manualRecording?.length) return null
    const p1Count = manualRecording.filter(s => s.forceN != null).length
    return p1Count / (manualRecording.length - 1)
  }, [manualRecording])

  // Photo crack progress — 0→1 cursor for the SVG strand animation, independent of
  // the particle canvas (scrubT / manualP2T). Adjust timing here without touching particles.
  // Blue: crack propagates over first 10% of scrub bar (appears quickly at start of p2).
  // Red/grey: crack propagates over last 5% of scrub bar (dramatic appearance at end).
  const photoCrackProgress = isManual
    ? (manualInP2 ? manualP2T : 0)
    : (isScrubbable
        ? (activeBox === 'blue' && photoView === 'off'
            ? Math.max(0, Math.min(1, scrubT / 0.10))
            : photoView === 'full' && p2StartFrac != null
                ? Math.max(0, Math.min(1, (scrubT - p2StartFrac) / 0.05))
                : Math.max(0, Math.min(1, (scrubT - 0.95) / 0.05)))
        : null)

  const scrubElapsed = photoCrackProgress != null ? photoCrackProgress * totalCrackMs : null

  // Blue box: place at deepest fromTop strand endpoint, only when crack doesn't go all the way through
  const bestBranch = useMemo(() => {
    if (currentCrackParams.depth >= 1.0) return null
    const fromTop = macroCrackStrands.filter(s => s.fromTop)
    if (!fromTop.length) return null
    return fromTop.reduce((best, s) =>
      s.pts[s.pts.length - 1][1] > best.pts[best.pts.length - 1][1] ? s : best
    )
  }, [macroCrackStrands, currentCrackParams.depth])

  function clearRecording() {
    if (replayRafRef.current) { cancelAnimationFrame(replayRafRef.current); replayRafRef.current = null }
    setHasRecording(false); setScrubT(1)
  }
  function startReplay(speedMul) {
    if (replayRafRef.current) cancelAnimationFrame(replayRafRef.current)
    replayRafRef.current = null
    const duration = 3000 / speedMul
    const start = performance.now()
    setScrubT(0)
    function tick(now) {
      const t = Math.min(1, (now - start) / duration)
      setScrubT(t)
      if (t < 1) replayRafRef.current = requestAnimationFrame(tick)
      else replayRafRef.current = null
    }
    replayRafRef.current = requestAnimationFrame(tick)
  }
  function startTest()  { breakFiredRef.current = false; clearRecording(); setPhase('testing'); setBluePhase('testing'); setActiveBox(ab => ab === 'grey' ? 'grey' : 'red'); setForce(1); setLiveDispForce(0); setBreakKN(null); setBlueHasRecording(false); setP2StartFrac(null); setInitialBondCounts(bondCounts) }
  function reset()      { breakFiredRef.current = false; clearRecording(); setPhase('idle'); setBluePhase('idle'); setActiveBox(ab => ab === 'grey' ? 'grey' : 'red'); setLiveDispForce(0); setBreakKN(null); setBlueHasRecording(false); setP2StartFrac(null); setLayoutSeed(Math.round(Math.random() * 1e6)); setBlueLayoutSeed(Math.round(Math.random() * 1e6)); setGreyLayoutSeed(Math.round(Math.random() * 1e6)); setInitialBondCounts(null) }
  function handleReplay() {
    breakFiredRef.current = false
    setLiveDispForce(0)
    clearRecording()
    setBlueHasRecording(false)
    blueReplayRef.current = true
    setBluePhase('idle')
    replayRef.current = true
    setPhase('idle')
  }

  function handleSandPct(pct) {
    clearRecording(); setSandPct(pct); setPhase('idle'); setLiveDispForce(0); setLayoutSeed(Math.round(Math.random() * 1e6)); setGreyLayoutSeed(Math.round(Math.random() * 1e6)); setBreakKN(null); setInitialBondCounts(null); setManualRecording(null); setManualForceN(0); setManualBreakN(null); setManualP2T(0)
  }

  const handleForceUpdate = useCallback((f) => setLiveDispForce(f), [])

  function handleRecordingReady(p2Frac) { setHasRecording(true); if (p2Frac != null) setP2StartFrac(p2Frac) }
  function handleFailed(kn)  {
    if (breakFiredRef.current) return
    breakFiredRef.current = true
    let displayKN = null
    if (kn != null) {
      const z        = Math.tanh((kn - (LIVE_OBSERVED_MEAN_KN[sandPct] ?? 1000)) / (LIVE_OBSERVED_STD_KN[sandPct] ?? 200))
      const targetMean = SAND_BREAK_KN[sandPct] ?? 600
      const targetCv   = SAND_BREAK_VAR[sandPct] ?? 0.10
      displayKN = Math.max(1, Math.round(targetMean * (1 + z * targetCv)))
      console.log(`[BREAK] sandPct=${sandPct}  internalKN=${kn}  z=${z.toFixed(3)}  displayKN=${displayKN}  target=${targetMean}±${(targetCv*100).toFixed(0)}%`)
    }
    setPhase('failed'); setBreakKN(displayKN)
  }
  function handleSettled() { setPhase('settled') }

  function handleBoxClick(box) {
    if (photoView !== 'full') return
    setActiveBox(box)
    setScrubT(1)
    setPhotoView('zooming')
    const stepMs = PHASE1_DURATION / PHASE1_STEPS
    let step = 0

    function advance() {
      step++
      setPhotoScale(Math.pow(PHASE1_RATIO, step))
      if (step < PHASE1_STEPS) {
        setPhase1Step(step)
        zoomTimerRef.current = setTimeout(advance, stepMs)
      } else if (step === PHASE1_STEPS) {
        // Trigger sim reveal + phase 2, but keep zooming
        setPhase1Step(0)
        setSimReady(true)
        setPhase2Active(true)
        setPhase2Step(0)
        zoomTimerRef.current = setTimeout(advance, stepMs)
      } else {
        // Continue zooming until phase 2 hides the photo
        zoomTimerRef.current = setTimeout(advance, stepMs)
      }
    }
    zoomTimerRef.current = setTimeout(advance, stepMs)
  }

  useEffect(() => {
    if (!phase2Active) return
    const stepMs = PHASE2_DURATION / PHASE2_STEPS
    let step = 0

    function advance() {
      step++
      setPhase2Step(step)
      if (step < PHASE2_STEPS) {
        p2TimerRef.current = setTimeout(advance, stepMs)
      } else {
        clearTimeout(zoomTimerRef.current)   // stop the zoom
        setPhase2Active(false)
        setPhase2Step(0)
        setPhotoView('off')
        setPhotoScale(1)
      }
    }
    p2TimerRef.current = setTimeout(advance, stepMs)
    return () => clearTimeout(p2TimerRef.current)
  }, [phase2Active])

  const speed = SPEEDS[speedIdx]
  const cropFrac = photoVShift / 100
  const pzlAspect = 3000 / (PZL_IMG_H * (1 - cropFrac))

  const boxW = 8 * photoBoxSize
  const boxH = boxW * (VH / VW) * pzlAspect

  let blueBoxPos = null
  if (bestBranch) {
    const [xnE, ynE] = bestBranch.pts[bestBranch.pts.length - 1]
    blueBoxPos = {
      x: photoBoxX + (xnE - 0.5) * CRACK_X_FAC * boxW * CRACK_SCALE,
      y: photoBoxY + ynE * CRACK_Y_FAC * boxH * CRACK_SCALE,
    }
  }
  const greyBoxX = pusherX
  const greyBoxY = photoBoxY + GREY_Y_EXTRA + boxH / 2
  const zoomOriginX = activeBox === 'blue' && blueBoxPos ? blueBoxPos.x
    : activeBox === 'grey' ? greyBoxX
    : photoBoxX
  const zoomOriginY = activeBox === 'blue' && blueBoxPos ? blueBoxPos.y
    : activeBox === 'grey' ? greyBoxY
    : photoBoxY + boxH / 2

  const inPhase2     = phase2Active
  const needsP2Xfrm  = inPhase2
  const showPhoto    = photoView !== 'off'
  const p1Frac       = phase1Step / PHASE1_STEPS

  // SimThumb fades from 0 at phase-1 midpoint to 1 at end; stays 1 once phase 1 completes
  const thumbOpacity = simReady
    ? 1
    : Math.max(0, Math.min(1, (p1Frac - 0.5) * 2))

  const FINAL_ZOOM_SCALE = Math.pow(PHASE1_RATIO, PHASE1_STEPS)
  const effectivePhotoScale = showDevSliders && showPhoto
    ? 1 + (FINAL_ZOOM_SCALE - 1) * zoomScrubT
    : photoScale
  const effectiveThumbOpacity = showDevSliders
    ? Math.max(0, Math.min(1, (zoomScrubT - 0.5) * 2))
    : thumbOpacity
  const effectiveBoxBgAlpha = showDevSliders
    ? Math.max(0, (zoomScrubT - 0.5) * 2)
    : (simReady ? 1 : Math.max(0, (p1Frac - 0.5) * 2))

  const borderPx = 2.5 / effectivePhotoScale

  // Phase-2 transform: moves/scales sim wrapper to match red box in photo, then back to normal.
  // Uses getBoundingClientRect so photo-stage and micro-square can have independent sizes.
  function computeP2Transform(p2T, msEl = microSquareRef.current) {
    const psEl = photoStageRef.current   // photo stage (covers micro-section)
    if (!psEl || !msEl) return 'none'

    const psRect = psEl.getBoundingClientRect()
    const msRect = msEl.getBoundingClientRect()

    // Photo-zoom-layer is letterboxed inside photo-stage
    const psAspect = psRect.width / psRect.height
    const pzlWFrac = psAspect > pzlAspect ? pzlAspect / psAspect : 1
    const pzlHFrac = psAspect > pzlAspect ? 1 : psAspect / pzlAspect
    const pzlL = psRect.left + (1 - pzlWFrac) / 2 * psRect.width
    const pzlT = psRect.top  + (1 - pzlHFrac) / 2 * psRect.height
    const pzlW = pzlWFrac * psRect.width
    const pzlH = pzlHFrac * psRect.height

    // Red box center screen position (at finalScale, origin is the box center so it stays put)
    const finalScale = Math.pow(PHASE1_RATIO, PHASE1_STEPS)
    const boxCX = pzlL + zoomOriginX / 100 * pzlW
    const boxCY = pzlT + zoomOriginY / 100 * pzlH

    // Red box rendered size (zoomed in by finalScale, measured against pzl size)
    const rendBoxW = boxW / 100 * pzlW * finalScale
    const rendBoxH = boxH / 100 * pzlH * finalScale

    // Sim wrapper center
    const simCX = msRect.left + msRect.width  / 2
    const simCY = msRect.top  + msRect.height / 2

    // Scale and translation at start of phase 2 (t=0): sim appears as small as the red box
    const sx0 = rendBoxW / msRect.width
    const sy0 = rendBoxH / msRect.height
    const tx0 = (boxCX - simCX) / msRect.width  * 100   // % of sim width
    const ty0 = (boxCY - simCY) / msRect.height * 100   // % of sim height

    const tx = tx0 * (1 - p2T)
    const ty = ty0 * (1 - p2T)
    return `translate(${tx}%, ${ty}%) scale(${lerp(sx0, 1, p2T)}, ${lerp(sy0, 1, p2T)})`
  }

  const targetPanelEl = activeBox === 'blue' ? blueSquareRef.current : microSquareRef.current
  const p2Transform = inPhase2
    ? computeP2Transform(phase2Step / PHASE2_STEPS, targetPanelEl)
    : 'none'

  const panelForce = isManual ? manualNormForce : force

  // Effective bend anim: 1.0 in manual mode (force directly controls bend), else scrub or ramp.
  // Photo view: ramp with scrubT through phase 1, then snap to 1 at p2StartFrac to replicate
  // the live-test jump (bar reaches max bend the moment particles start separating).
  const effectiveBendAnim = isManual ? 1.0
    : ((photoView === 'off' || photoView === 'full') && hasRecording
        ? (photoView === 'full' && p2StartFrac != null
            ? (scrubT < p2StartFrac ? scrubT : 1.0)
            : scrubT)
        : bendAnim)


  // Force shown in LCD during scrub: linearly interpolated across p1 portion of recording
  const scrubDisplayKN = (() => {
    if (phase !== 'failed' || breakKN == null || !hasRecording || p2StartFrac == null) return null
    if (scrubT >= p2StartFrac) return breakKN
    return Math.round(scrubT / p2StartFrac * breakKN)
  })()

  // 0% sand has almost no grain-layout variability (no sand grains), so fbf randomness
  // is restored for that ratio. All other ratios use constant fbf; grain layout provides variability.
  const effectiveFaultBreakFactor = useMemo(() => {
    const base = SAND_FAULT_BREAK[sandPct] ?? FAULT_BREAK_FACTOR
    if (sandPct === 0) {
      const r = seededRandom(layoutSeed)
      return base * (1 + (r * 2 - 1) * SAND_BREAK_VAR[0])
    }
    return base
  }, [sandPct, layoutSeed])

  const kNScale        = SAND_KN_SCALE[sandPct] ?? 0.381
  const manualForceStep = 20 * MANUAL_MAX_N / (2500 * (manualEffectiveScale ?? kNScale))
  const liveSpecCeil   = Math.round((SAND_BREAK_KN[sandPct] ?? 600) * (1 + (SAND_BREAK_VAR[sandPct] ?? 0.10)))
  const liveDisplayKN  = scrubDisplayKN != null ? scrubDisplayKN : Math.min(Math.round(liveDispForce * 2500 * kNScale), liveSpecCeil)
  const manualDisplayKN = Math.round(((manualInP2 && manualBreakN != null ? manualBreakN : manualForceN) / MANUAL_MAX_N) * 2500 * (manualEffectiveScale ?? kNScale))
  const displayKN = isManual ? manualDisplayKN : liveDisplayKN

  // Grey panel compression: ramps 0→1 during loading, snaps to 0 at break.
  const compressionT = isManual
    ? (manualP2StartFrac != null
        ? (manualScrubT < manualP2StartFrac ? manualScrubT / manualP2StartFrac : 0)
        : 0)
    : (photoView === 'off'
        ? (phase === 'testing'
            ? bendAnim
            : (hasRecording && p2StartFrac != null
                ? (scrubT < p2StartFrac ? scrubT / p2StartFrac : 0)
                : 0))
        : 0)

  // How much the pusher drops: quadratic drop at pusherX position within the bar,
  // converted from bar-natural-height fraction to photo-layer-height %
  const tPusher      = Math.max(0, Math.min(1, (pusherX - barX) / Math.max(barSize, 0.1)))
  const pusherDropPct = panelForce * 0.04 * effectiveBendAnim * tPusher * tPusher
                        * barSize * BAR_IMG_AR * pzlAspect

  const showPhotoCracks = isManual
    ? (manualRecording != null && manualBreakN != null && manualForceN >= manualBreakN && macroCrackStrands.length > 0)
    : (phase === 'failed' && macroCrackStrands.length > 0)
  const showBlueCrack = showPhotoCracks && blueBoxPos !== null

  const effectiveSimReady = showDevSliders ? zoomScrubT > 0.5 : simReady
  const simWrapperStyle = {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
    visibility: (!showPhoto || (activeBox === 'red' && (effectiveSimReady || needsP2Xfrm))) ? 'visible' : 'hidden',
    ...(needsP2Xfrm && activeBox !== 'blue' ? {
      position: 'relative',
      zIndex: 20,
      transform: p2Transform,
      transformOrigin: '50% 50%',
    } : {}),
  }
  const blueWrapperStyle = {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
    visibility: (!showPhoto || (activeBox === 'blue' && (effectiveSimReady || needsP2Xfrm))) ? 'visible' : 'hidden',
    ...(needsP2Xfrm && activeBox === 'blue' ? {
      position: 'relative',
      zIndex: 20,
      transform: p2Transform,
      transformOrigin: '50% 50%',
    } : {}),
  }

  return (
    <div className="viewer">
      <header className="top-bar">
        <div className="toolbar" style={{ flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 0, position: 'relative', paddingBottom: 36 }}>
          <div className="panel-bolt" style={{ top: 9, left: 9 }} />
          <div className="panel-bolt" style={{ top: 9, right: 9 }} />
          <div className="panel-bolt" style={{ bottom: 9, left: 9 }} />
          <div className="panel-bolt" style={{ bottom: 9, right: 9 }} />
          {/* Scrub slider — sits between the bottom bolts; hidden in manual mode */}
          <div style={{ position: 'absolute', bottom: 7, left: 50, right: 50, display: (isManual || photoView !== 'off') ? 'none' : 'flex', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0, pointerEvents: activeHasRecording ? 'auto' : 'none' }}>
              <ScrubSlider value={scrubT} onChange={v => {
                if (replayRafRef.current) { cancelAnimationFrame(replayRafRef.current); replayRafRef.current = null }
                setScrubT(v)
              }} disabled={!activeHasRecording} />
            </div>
          </div>
          {/* Tab strip */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 2, marginBottom: 5 }}>
            <button
              className={`tab-btn ${controlTab === 'ratio' ? 'active' : ''}`}
              onClick={() => { setControlTab('ratio'); breakFiredRef.current = false; clearRecording(); setPhase('idle'); setBluePhase('idle'); setLiveDispForce(0); setBreakKN(null); setBlueHasRecording(false); setP2StartFrac(null); setInitialBondCounts(null) }}
            >Break Test</button>
            <button
              className={`tab-btn ${controlTab === 'manual' ? 'active' : ''}`}
              onClick={() => { setControlTab('manual'); setManualForceN(0); if (photoView !== 'off') cancelZoom() }}
            >Manual Force Values</button>
          </div>

          {/* Action row: tab-specific left/center + persistent right column */}
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            {/* Tab-specific left+center — flex:1 so it absorbs all remaining space */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', minWidth: 0 }}>
              {controlTab === 'ratio' ? (
                <>
                  {/* Sand preset group */}
                  <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline' }}>
                      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#8a6a0a' }}>% Sand</span>
                      <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5a7888', marginLeft: 3 }}>/ Cement</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      {SAND_PRESETS.map(pct => (
                        <button key={pct}
                          className={`preset-btn ${sandPct === pct ? 'active' : ''}`}
                          onClick={() => handleSandPct(pct)}
                        >
                          <span style={{ color: '#c8a020' }}>{pct}</span><span style={{ color: '#6a8898' }}>/{100 - pct}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="toolbar-divider" style={{ flexShrink: 0 }} />
                  <div style={{ flex: 1 }} />
                  {/* Action buttons */}
                  <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {phase === 'failed' || phase === 'settled'
                      ? <button className="action-btn test-btn" style={{ width: 68, padding: '3px 0' }} onClick={() => handleSandPct(sandPct)}>Reset</button>
                      : <button className="action-btn test-btn" style={{ width: 68, padding: '3px 0' }} onClick={startTest} disabled={phase === 'testing'}>Test</button>
                    }
                    <div style={{ position: 'relative', background: '#909e77', border: '1px solid rgba(100,90,70,0.5)', borderRadius: 3, fontFamily: '"DSEG7","Courier New",monospace', fontSize: 18, letterSpacing: '0.05em', lineHeight: 1, userSelect: 'none' }}>
                      <span style={{ visibility: 'hidden', display: 'block', padding: '3px 6px' }}>8888</span>
                      <span style={{ position: 'absolute', inset: 0, padding: '3px 6px', color: 'rgba(60,60,60,0.15)', textAlign: 'right' }}>8888</span>
                      <span style={{ position: 'absolute', inset: 0, padding: '3px 6px', color: 'rgba(60,60,60,0.75)', textAlign: 'right' }}>{liveDisplayKN}</span>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.10em', color: 'rgba(30,45,60,0.70)' }}>kN</span>
                    <button
                      className="action-btn test-btn"
                      onClick={() => startReplay(0.25)}
                      disabled={!activeHasRecording}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    ><img src="/concrete/Turtle.png" draggable={false} style={{ height: '1.5em', filter: 'brightness(0) invert(1) brightness(0.7) sepia(1) hue-rotate(166deg) brightness(0.95)', marginRight: 3 }} /><span style={{ fontSize: '1.4em', color: '#90c8f0', lineHeight: 1 }}>↺</span></button>
                    <button
                      className="action-btn test-btn"
                      onClick={() => startReplay(1)}
                      disabled={!activeHasRecording}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    ><img src="/concrete/Rabbit.png" draggable={false} style={{ height: '1.5em', filter: 'brightness(0) invert(1) brightness(0.7) sepia(1) hue-rotate(166deg) brightness(0.95)', marginRight: 3 }} /><span style={{ fontSize: '1.4em', color: '#90c8f0', lineHeight: 1 }}>↺</span></button>
                  </div>
                  <div style={{ flex: 1 }} />
                  <div className="toolbar-divider" style={{ flexShrink: 0 }} />
                </>
              ) : !manualRecording ? (
                <div style={{ flex: 1, color: 'rgba(200,215,230,0.55)', fontSize: 14, fontWeight: 600, letterSpacing: '0.08em', textAlign: 'center' }}>
                  Loading…
                </div>
              ) : (
                <>
                  {/* Sand:Cement presets */}
                  <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline' }}>
                      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#8a6a0a' }}>% Sand</span>
                      <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5a7888', marginLeft: 3 }}>/ Cement</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      {SAND_PRESETS.map(pct => (
                        <button key={pct}
                          className={`preset-btn ${sandPct === pct ? 'active' : ''}`}
                          onClick={() => handleSandPct(pct)}
                        >
                          <span style={{ color: '#c8a020' }}>{pct}</span><span style={{ color: '#6a8898' }}>/{100 - pct}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="toolbar-divider" style={{ flexShrink: 0 }} />
                  <div style={{ flex: 1 }} />
                  {/* Force buttons */}
                  <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      className="action-btn replay-btn"
                      style={{ padding: '3px 9px' }}
                      onClick={() => setManualForceN(n => Math.max(0, n - manualForceStep))}
                      disabled={manualForceN === 0 || manualInP2}
                    ><span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.1 }}><span style={{ fontSize: '1.6em' }}>−</span><span style={{ textTransform: 'none', fontSize: '0.85em', whiteSpace: 'nowrap' }}>20 kN</span></span></button>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, marginTop: -10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ position: 'relative', background: '#909e77', border: '1px solid rgba(100,90,70,0.5)', borderRadius: 3, fontFamily: '"DSEG7","Courier New",monospace', fontSize: 18, letterSpacing: '0.05em', lineHeight: 1, userSelect: 'none' }}>
                          <span style={{ visibility: 'hidden', display: 'block', padding: '3px 6px' }}>8888</span>
                          <span style={{ position: 'absolute', inset: 0, padding: '3px 6px', color: 'rgba(60,60,60,0.15)', textAlign: 'right' }}>8888</span>
                          <span style={{ position: 'absolute', inset: 0, padding: '3px 6px', color: 'rgba(60,60,60,0.75)', textAlign: 'right' }}>{Math.round(((manualInP2 && manualBreakN != null ? manualBreakN : manualForceN) / MANUAL_MAX_N) * 2500 * (manualEffectiveScale ?? kNScale))}</span>
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.10em', color: 'rgba(30,45,60,0.70)' }}>kN</span>
                      </div>
                      <button
                        className="action-btn replay-btn"
                        style={{ padding: '1px 10px', fontSize: 11 }}
                        onClick={() => setManualForceN(0)}
                        disabled={manualForceN === 0 && !manualInP2}
                      >Reset</button>
                    </div>
                    <button
                      className="action-btn test-btn"
                      style={{ padding: '3px 9px' }}
                      onClick={() => setManualForceN(n => Math.min(MANUAL_MAX_N, n + manualForceStep))}
                      disabled={manualInP2}
                    ><span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.1 }}><span style={{ fontSize: '1.6em' }}>+</span><span style={{ textTransform: 'none', fontSize: '0.85em', whiteSpace: 'nowrap' }}>20 kN</span></span></button>
                  </div>
                  <div style={{ flex: 1 }} />
                  <div className="toolbar-divider" style={{ flexShrink: 0 }} />
                </>
              )}
            </div>
            {/* Persistent right column: toggle directly above Show/Hide — never moves */}
            {photoView === 'off' ? (
              <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative', top: -20 }}>
                  <span style={{ fontSize: 15, lineHeight: 1, userSelect: 'none', color: '#ffc020', display: 'inline-block', width: 18, textAlign: 'center' }}>{darkMode ? '☽' : '☀'}</span>
                  <div onClick={() => setDarkMode(f => !f)} style={{ width: 36, height: 20, borderRadius: 10, cursor: 'pointer', background: darkMode ? 'rgba(140,180,255,0.25)' : 'rgba(255,200,40,0.35)', border: darkMode ? '1px solid rgba(140,180,255,0.4)' : '1px solid rgba(200,150,20,0.45)', position: 'relative', transition: 'background 0.2s, border-color 0.2s', flexShrink: 0 }}>
                    <div style={{ width: 14, height: 14, borderRadius: 7, background: darkMode ? '#a0c0ff' : '#ffc020', position: 'absolute', top: 2, left: darkMode ? 2 : 18, transition: 'left 0.2s, background 0.2s', boxShadow: darkMode ? '0 0 6px rgba(160,200,255,0.9)' : '0 0 6px rgba(255,180,0,0.9)' }} />
                  </div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'rgba(30,45,60,0.70)' }}>Show/Hide Visuals</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <button className={`action-btn replay-btn${showCount ? ' active' : ''}`} style={{ padding: '3px 13px' }} onClick={() => setShowCount(f => !f)}>Count</button>
                  <button className={`action-btn replay-btn${chargeVisible ? ' active' : ''}`} style={{ padding: '3px 13px' }} onClick={() => setChargeVisible(f => !f)}>Charge</button>
                  <button className={`action-btn replay-btn${showField ? ' active' : ''}`} style={{ padding: '3px 13px' }} onClick={() => setShowField(f => !f)}>Field</button>
                </div>
              </div>
            ) : (
              <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 3 }}>
                <button className="action-btn" style={{ background: 'rgba(200,40,40,0.25)', borderColor: 'rgba(200,60,60,0.6)', color: '#ff8888' }} onClick={() => handleBoxClick('red')}>Zoom to Crack Start</button>
              </div>
            )}
          </div>


        </div>

        {/* Live mini photo preview — always in sync with main photo */}
        <div className="beam-photo">
          <div
            ref={miniPhotoRef}
            style={{
              position: 'relative',
              width: '100%',
              flexShrink: 0,
              overflow: 'hidden',
              aspectRatio: `3000 / ${PZL_IMG_H * (1 - cropFrac)}`,
              cursor: photoView === 'off' ? 'zoom-out' : 'default',
              transform: `scale(1.1)`,
              transformOrigin: 'top center',
            }}
            onClick={() => { if (photoView === 'off') zoomOut() }}
          >
            <PhotoScene
              cropFrac={cropFrac}
              sandPct={sandPct} barX={barX} barY={barY} barSize={barSize}
              bend={panelForce * 0.04 * effectiveBendAnim}
              macroCrackStrands={macroCrackStrands} currentCrackParams={currentCrackParams}
              photoBoxX={photoBoxX}
              boxW={boxW} boxH={boxH}
              crackScale={THUMB_CRACK_SCALE}
              scrubElapsed={scrubElapsed}
              pusherX={pusherX} pusherY={pusherY + pusherDropPct} pusherNudgePct={-0.5}
              pusherSize={pusherSize}
              lcdX={lcdX} lcdY={lcdY + pusherDropPct} lcdKN={displayKN} containerW={miniPhotoW} lcdNudge={{ dx: 0, dy: -1 }}
              showPhotoCracks={showPhotoCracks} showBlueCrack={showBlueCrack}
              photoViewIsZooming={photoView === 'zooming'}
              photoBoxY={photoBoxY} blueBoxPos={blueBoxPos} greyBoxX={greyBoxX}
              showZoomUI={true}
              borderPx={2}
              effectivePhotoScale={1}
              effectiveBoxBgAlpha={0}
              capLength={capLength} capAngle={capAngle}
              circleScale={2}
              hintNudges={{
                red:  { circleDx:  2, circleDy:  -4, textDx:  45, textDy:  20 },
                blue: { circleDx: -2, circleDy:   5, textDx:  33, textDy: -10 },
                grey: { circleDx:  0, circleDy:   0, textDx:   0, textDy: -10 },
              }}
              onBoxClick={(box) => {
                if (photoView === 'full') {
                  if (box === 'grey') setGreyLayoutSeed(s => s + 1)
                  handleBoxClick(box)
                } else if (photoView === 'off') {
                  setActiveBox(box)
                }
              }}
              boxCursor="pointer"
            />
          </div>
        </div>
      </header>

      <main className="micro-section">
        {photoView === 'off' && (
          <div className="force-viz-space">
            {/* Particle key */}
            {(() => {
              const sandAtoms = [
                { particles: [{ x: 0, y: 0, r: 4,   type: 'Si' }],                label: <><b>Si</b> <sup>δ+</sup></> },
                { particles: [{ x: 0, y: 0, r: 3,   type: 'O',  isGrain: true }], label: <><b>O</b> <sup>δ−</sup></>  },
              ]
              const cementAtoms = [
                { particles: [{ x: 0, y: 0, r: 5.5, type: 'Ca' }],                 label: <><b>Ca</b> <sup>2+</sup></> },
                { particles: [{ x: 0, y: 0, r: 3,   type: 'O',  isGrain: false }], label: <><b>OH</b><sup>−</sup></>   },
              ]
              const labelStyle = { fontSize: 22, color: darkMode ? '#999' : '#666', fontFamily: 'Lexend, system-ui, sans-serif' }
              const groupGrid  = atoms => (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 3 }}>
                  {atoms.map(({ particles }, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                      <BondIcon particles={particles} bonds={[]} scale={1.5} darkMode={darkMode} showCharge={chargeVisible} />
                    </div>
                  ))}
                  {atoms.map(({ label }, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                      <span style={labelStyle}>{label}</span>
                    </div>
                  ))}
                </div>
              )
              return (
                <div style={{ display: 'flex', flexShrink: 0, padding: '0 6px', gap: 6 }}>
                  <div style={{ flex: 1, border: '1.5px solid goldenrod', borderRadius: 4, padding: '4px 4px 2px', boxShadow: '0 0 0 1px rgba(0,0,0,0.6), 0 0 8px rgba(212,160,32,0.5)' }}>
                    {groupGrid(sandAtoms)}
                    <div style={{ textAlign: 'center', fontSize: 10, color: 'goldenrod', fontFamily: 'Lexend, system-ui, sans-serif', letterSpacing: '0.08em', marginTop: 2 }}>SAND</div>
                  </div>
                  <div style={{ flex: 1, padding: '4px 4px 2px' }}>
                    {groupGrid(cementAtoms)}
                    <div style={{ textAlign: 'center', fontSize: 10, color: darkMode ? '#999' : '#888', fontFamily: 'Lexend, system-ui, sans-serif', letterSpacing: '0.08em', marginTop: 2 }}>CEMENT</div>
                  </div>
                </div>
              )
            })()}
            {/* Bond strain key */}
            {showField && (
              <svg viewBox="0 0 200 50" width="100%" style={{ display: 'block', flexShrink: 0 }}>
                <defs>
                  <linearGradient id="cv-strain-grad" x1="0" x2="1" y1="0" y2="0">
                    {darkMode ? (<>
                      <stop offset="0%"   stopColor="rgb(200,196,188)" />
                      <stop offset="20%"  stopColor="rgb(195,90,255)" />
                      <stop offset="55%"  stopColor="rgb(240,30,225)" />
                      <stop offset="100%" stopColor="rgb(255,70,185)" />
                    </>) : (<>
                      <stop offset="0%"   stopColor="rgb(172,167,160)" />
                      <stop offset="20%"  stopColor="rgb(190,100,220)" />
                      <stop offset="55%"  stopColor="rgb(150,20,200)" />
                      <stop offset="100%" stopColor="rgb(255,40,160)" />
                    </>)}
                  </linearGradient>
                </defs>
                <text x="0" y="14" style={{ fontSize: '14px', fill: darkMode ? '#999' : '#666', fontFamily: 'Lexend, system-ui, sans-serif' }}>Energy in fields:</text>
                <rect x="0" y="18" width="200" height="10" fill="url(#cv-strain-grad)" rx="1" />
                <text x="0"   y="44" style={{ fontSize: '16px', fill: darkMode ? '#666' : '#888', fontFamily: 'Lexend, system-ui, sans-serif' }}>Low</text>
                <text x="200" y="44" style={{ fontSize: '16px', fill: darkMode ? '#666' : '#888', fontFamily: 'Lexend, system-ui, sans-serif', textAnchor: 'end' }}>High</text>
              </svg>
            )}
            {showCount && <div className="bond-analysis-box">
              {bondCounts && (() => {
                const tested = initialBondCounts !== null
                const rows = [
                  {
                    key: 'sand', label: 'Sand', color: '#c8961e',
                    getValue: c => c.siO,
                    icon: <BondIcon darkMode={darkMode} showCharge={chargeVisible} scale={1.5} particles={[
                      { x: 0, y: 0, r: 4, type: 'Si' },
                      { x: 16, y: 0, r: 3, type: 'O', isGrain: true },
                    ]} bonds={[{ i: 0, j: 1 }]} />,
                  },
                  {
                    key: 'sandCement', label: 'Sand-Cement', color: '#9c6828',
                    getValue: c => c.caO + c.siOH,
                    icon: <BondIcon darkMode={darkMode} showCharge={chargeVisible} scale={1.5} particles={[
                      { x: 0, y: 0,  r: 5.5, type: 'Ca' },
                      { x: 16, y: 0,  r: 3,   type: 'O', isGrain: true },
                      { x: 0, y: 14, r: 4,   type: 'Si' },
                      { x: 16, y: 14, r: 3,   type: 'O', isGrain: false },
                    ]} bonds={[{ i: 0, j: 1 }, { i: 2, j: 3 }]} />,
                  },
                  {
                    key: 'concrete', label: 'Cement', color: '#9a9292',
                    getValue: c => c.caOH,
                    icon: <BondIcon darkMode={darkMode} showCharge={chargeVisible} scale={1.5} particles={[
                      { x: 0,  y: 0, r: 5.5, type: 'Ca' },
                      { x: 16, y: 0, r: 3,   type: 'O', isGrain: false },
                    ]} bonds={[{ i: 0, j: 1 }]} />,
                  },
                ]
                const colData = rows.map(({ key, label, color, getValue, icon }) => {
                  const now    = getValue(bondCounts)
                  const before = getValue(initialBondCounts ?? bondCounts)
                  const broken = Math.max(0, before - now)
                  return { key, label, color, icon, now, before, broken }
                })
                const totalBroken = colData.reduce((s, d) => s + d.broken, 0)
                const valueRows = [
                  { key: 'before', label: 'Before', getCell: d => ({ val: d.before, bold: false }) },
                  { key: 'now',    label: 'Now',    getCell: d => ({ val: tested ? d.now : null, bold: false }) },
                  { key: 'broken', label: 'Broken', getCell: d => ({
                    val: tested ? d.broken : null,
                    pct: tested && d.before > 0 ? d.broken / d.before * 100 : null,
                    bold: true,
                  }) },
                  { key: 'total', label: 'Total', getCell: d => ({
                    pct: tested && totalBroken > 0 ? d.broken / totalBroken * 100 : null,
                    bold: false,
                  }) },
                ]
                return (
                  <div style={{ padding: '6px 4px', display: 'flex', flexDirection: 'column', gap: 0, height: '100%', boxSizing: 'border-box' }}>
                    {/* Column headers — bond type icons + labels */}
                    <div style={{ display: 'grid', gridTemplateColumns: '42px 0.9fr 0.9fr 0.9fr', gap: '0', alignItems: 'end', marginBottom: 4 }}>
                      <span />
                      {colData.map(({ key, label, color, icon }) => (
                        <div key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                          {icon}
                          <span style={{ fontSize: 14, color, letterSpacing: '0.04em', lineHeight: 1, textAlign: 'center', fontFamily: 'Lexend, system-ui, sans-serif' }}>{label}</span>
                        </div>
                      ))}
                    </div>
                    {/* Value rows */}
                    {valueRows.map(({ key, label, getCell }) => (
                      <div key={key} style={{ display: 'grid', gridTemplateColumns: '42px 0.9fr 0.9fr 0.9fr', gap: '0', alignItems: 'baseline', marginBottom: 3 }}>
                        <span style={{ fontSize: 14, letterSpacing: '0.07em', color: darkMode ? '#888' : '#666', fontFamily: 'Lexend, system-ui, sans-serif' }}>{label}</span>
                        {colData.map(d => {
                          const { val, pct, bold } = getCell(d)
                          return (
                            <div key={d.key} style={{ textAlign: 'center' }}>
                              {val != null && (
                                <div style={{ fontSize: 23, fontVariantNumeric: 'tabular-nums', color: d.color, fontWeight: bold ? 700 : 500, lineHeight: 1.1, fontFamily: 'Lexend, system-ui, sans-serif' }}>{val}</div>
                              )}
                              {pct != null && (
                                <div style={{ fontSize: 18, color: d.color, opacity: 0.75, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, fontFamily: 'Lexend, system-ui, sans-serif' }}>{Math.round(pct)}%</div>
                              )}
                              {val == null && pct == null && (
                                <span style={{ fontSize: 22, color: darkMode ? '#333' : '#bbb', fontFamily: 'Lexend, system-ui, sans-serif' }}>—</span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>}
          </div>
        )}

        {/* Red view */}
        <div ref={microSquareRef} className="micro-square" style={{ border: '4px solid rgba(255,80,80,0.6)', display: photoView === 'off' && activeBox !== 'red' ? 'none' : undefined }}>
          <div style={simWrapperStyle}>
            <MicroPanelB
              sandPct={panelSandPct}
              phase={isManual ? (manualRecording ? 'failed' : 'idle') : (phase === 'failed' && !hasRecording ? 'testing' : phase)}
              layoutSeed={layoutSeed}
              force={panelForce} speed={speed} bondRound={bondRound} noDiag showDiag={showDevSliders}
              faultBreakFactor={effectiveFaultBreakFactor}
              onForceUpdate={isManual ? undefined : handleForceUpdate}
              onSettled={isManual ? () => {} : handleSettled}
              onFailed={isManual ? () => {} : handleFailed}
              scrubT={isManual ? manualScrubT : (photoView === 'off' && hasRecording ? scrubT : null)}
              onRecordingReady={isManual ? () => {} : handleRecordingReady}
              p2DispScale={redP2DispScale}
              showField={showField}
              showCharge={chargeVisible}
              darkMode={darkMode}
              preloadedRecording={isManual ? manualRecording : null}
              onBondCounts={setBondCounts}
            />
          </div>
        </div>

        {/* Blue view — big grain stops crack */}
        <div ref={blueSquareRef} className="micro-square" style={{ border: '2px solid rgba(80,140,255,0.6)', display: photoView === 'off' && activeBox !== 'blue' ? 'none' : undefined }}>
          <div style={blueWrapperStyle}>
            <MicroPanelB
              sandPct={panelSandPct}
              phase={isManual ? 'idle' : bluePhase}
              layoutSeed={blueLayoutSeed}
              force={isManual ? 0 : panelForce} speed={speed} bondRound={bondRound} noDiag showDiag={showDevSliders}
              faultBreakFactor={effectiveFaultBreakFactor}
              grainOverride={blueGrains}
              crackWaypoints={blueCrackWaypoints}
              accentColor="#3d6fd4"
              onSettled={isManual ? () => {} : () => setBluePhase('settled')}
              onFailed={isManual ? () => {} : () => setBluePhase('failed')}
              scrubT={isManual ? null : (photoView === 'off' && blueHasRecording ? scrubT : null)}
              onRecordingReady={isManual ? () => {} : () => setBlueHasRecording(true)}
              showField={showField}
              showCharge={chargeVisible}
              darkMode={darkMode}
            />
          </div>
        </div>

        {/* Grey view — static cross-section under pusher, always idle, never breaks */}
        <div className="micro-square" style={{ border: '4px solid rgba(80,80,80,0.9)', display: photoView === 'off' && activeBox === 'grey' ? undefined : 'none' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <MicroPanelB
              sandPct={panelSandPct} phase="idle" layoutSeed={greyLayoutSeed}
              force={0} speed={1} bondRound={bondRound} noDiag showDiag={showDevSliders}
              accentColor="#111111"
              onSettled={() => {}} onFailed={() => {}}
              scrubT={null}
              onRecordingReady={() => {}}
              showField={showField}
              showCharge={chargeVisible}
              darkMode={darkMode}
              compressionT={compressionT}
            />
          </div>
        </div>

        {showPhoto && (
          <div ref={photoStageRef} className="photo-stage">
            {showDevSliders && (() => {
              const ck = crackParams[sandPct]
              return (
                <div style={{
                  position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100,
                  display: 'flex', alignItems: 'center', flexWrap: 'nowrap', gap: 4, padding: '3px 6px',
                  background: 'rgba(255,255,255,0.82)', fontSize: 10, whiteSpace: 'nowrap', overflowX: 'auto',
                }}>
                  <span className="toolbar-label">Zoom</span>
                  <input type="range" min={0} max={1} step={0.001} value={zoomScrubT} disabled={!showPhoto}
                    style={{ width: 60, accentColor: '#6080a0' }} onChange={e => setZoomScrubT(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{zoomScrubT.toFixed(2)}</span>
                  <span className="toolbar-label" style={{ marginLeft: 4 }}>LCD</span>
                  <span className="toolbar-label">X</span>
                  <input type="range" min={0} max={100} step={0.5} value={lcdX}
                    style={{ width: 60, accentColor: '#40c8a0' }} onChange={e => setLcdX(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{lcdX.toFixed(1)}</span>
                  <span className="toolbar-label">Y</span>
                  <input type="range" min={0} max={100} step={0.5} value={lcdY}
                    style={{ width: 60, accentColor: '#40c8a0' }} onChange={e => setLcdY(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{lcdY.toFixed(1)}</span>
                  <span className="toolbar-label" style={{ marginLeft: 4 }}>Pusher</span>
                  <span className="toolbar-label">X</span>
                  <input type="range" min={0} max={100} step={0.1} value={pusherX}
                    style={{ width: 60, accentColor: '#7090b0' }} onChange={e => setPusherX(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{pusherX.toFixed(1)}</span>
                  <span className="toolbar-label">Y</span>
                  <input type="range" min={-20} max={100} step={0.1} value={pusherY}
                    style={{ width: 60, accentColor: '#7090b0' }} onChange={e => setPusherY(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{pusherY.toFixed(1)}</span>
                  <span className="toolbar-label">Sz</span>
                  <input type="range" min={1} max={60} step={0.1} value={pusherSize}
                    style={{ width: 60, accentColor: '#7090b0' }} onChange={e => setPusherSize(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{pusherSize.toFixed(1)}</span>
                  <span className="toolbar-label" style={{ marginLeft: 4 }}>Bar</span>
                  <span className="toolbar-label">X</span>
                  <input type="range" min={0} max={100} step={0.1} value={barX}
                    style={{ width: 60, accentColor: '#a07050' }} onChange={e => setBarX(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{barX.toFixed(1)}</span>
                  <span className="toolbar-label">Y</span>
                  <input type="range" min={0} max={100} step={0.1} value={barY}
                    style={{ width: 60, accentColor: '#a07050' }} onChange={e => setBarY(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{barY.toFixed(1)}</span>
                  <span className="toolbar-label">Sz</span>
                  <input type="range" min={1} max={100} step={0.1} value={barSize}
                    style={{ width: 60, accentColor: '#a07050' }} onChange={e => setBarSize(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{barSize.toFixed(1)}</span>
                  <span className="toolbar-label" style={{ marginLeft: 4 }}>Photo↑</span>
                  <input type="range" min={0} max={40} step={0.1} value={photoVShift}
                    style={{ width: 60, accentColor: '#70a080' }} onChange={e => setPhotoVShift(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{photoVShift.toFixed(1)}</span>
                  <span className="toolbar-label" style={{ marginLeft: 4 }}>Cap</span>
                  <span className="toolbar-label">Len</span>
                  <input type="range" min={0} max={30} step={0.1} value={capLength}
                    style={{ width: 60, accentColor: '#a060a0' }} onChange={e => setCapLength(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{capLength.toFixed(1)}</span>
                  <span className="toolbar-label">Ang</span>
                  <input type="range" min={-60} max={60} step={1} value={capAngle}
                    style={{ width: 60, accentColor: '#a060a0' }} onChange={e => setCapAngle(Number(e.target.value))} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{capAngle}</span>
                  <span className="toolbar-label" style={{ marginLeft: 4, color: '#806040' }}>Crack {sandPct}%</span>
                  <span className="toolbar-label">Dep</span>
                  <input type="range" min={0.05} max={1.5} step={0.01} value={ck.depth}
                    style={{ width: 50, accentColor: '#c09050' }} onChange={e => setCK('depth', +e.target.value)} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 28 }}>{ck.depth.toFixed(2)}</span>
                  <span className="toolbar-label">Dev</span>
                  <input type="range" min={0} max={0.60} step={0.005} value={ck.dev}
                    style={{ width: 50, accentColor: '#c09050' }} onChange={e => setCK('dev', +e.target.value)} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 28 }}>{ck.dev.toFixed(3)}</span>
                  <span className="toolbar-label">Sprd</span>
                  <input type="range" min={0} max={1.0} step={0.005} value={ck.branch}
                    style={{ width: 50, accentColor: '#c09050' }} onChange={e => setCK('branch', +e.target.value)} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 28 }}>{ck.branch.toFixed(2)}</span>
                  <span className="toolbar-label">W</span>
                  <input type="range" min={0.3} max={8.0} step={0.05} value={ck.widthMul}
                    style={{ width: 44, accentColor: '#c09050' }} onChange={e => setCK('widthMul', +e.target.value)} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{ck.widthMul.toFixed(1)}</span>
                  <span className="toolbar-label">Spd</span>
                  <input type="range" min={0.1} max={4.0} step={0.05} value={ck.speedMul}
                    style={{ width: 44, accentColor: '#c09050' }} onChange={e => setCK('speedMul', +e.target.value)} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{ck.speedMul.toFixed(1)}</span>
                  <span className="toolbar-label">Tpr</span>
                  <input type="range" min={-1} max={2} step={0.05} value={ck.taper}
                    style={{ width: 50, accentColor: '#c09050' }} onChange={e => setCK('taper', +e.target.value)} />
                  <span style={{ color: '#555', fontSize: 9, minWidth: 24 }}>{ck.taper.toFixed(2)}</span>
                </div>
              )
            })()}
            <div
              ref={zoomLayerRef}
              className="photo-zoom-layer"
              style={{
                aspectRatio: `3000 / ${PZL_IMG_H * (1 - cropFrac)}`,
                transformOrigin: `50% 50%`,
                // translate keeps zoom target at viewport centre: as scale grows, the offset
                // from photo-centre to zoom-target is amplified, so we counter it exactly.
                transform: effectivePhotoScale === 1
                  ? undefined
                  : `translate(${-effectivePhotoScale * (zoomOriginX - 50)}%, ${-effectivePhotoScale * (zoomOriginY - 50)}%) scale(${effectivePhotoScale})`,
                imageRendering: effectivePhotoScale > 5 ? 'pixelated' : 'auto',
              }}
            >
              <PhotoScene
                cropFrac={cropFrac}
                sandPct={sandPct} barX={barX} barY={barY} barSize={barSize}
                bend={panelForce * 0.04 * effectiveBendAnim}
                macroCrackStrands={macroCrackStrands} currentCrackParams={currentCrackParams}
                photoBoxX={photoBoxX}
                boxW={boxW} boxH={boxH}
                crackScale={CRACK_SCALE}
                scrubElapsed={scrubElapsed}
                pusherX={pusherX} pusherY={pusherY + pusherDropPct}
                pusherSize={pusherSize}
                lcdX={lcdX} lcdY={lcdY + pusherDropPct} lcdKN={displayKN} containerW={zoomLayerW}
                showPhotoCracks={showPhotoCracks} showBlueCrack={showBlueCrack}
                photoViewIsZooming={photoView === 'zooming'}
                photoBoxY={photoBoxY} blueBoxPos={blueBoxPos} greyBoxX={greyBoxX}
              showZoomUI={false}
                borderPx={borderPx}
                effectivePhotoScale={effectivePhotoScale}
                effectiveBoxBgAlpha={effectiveBoxBgAlpha}
                photoBoxHovered={boxHovered} onPhotoBoxHover={setBoxHovered}
                blueBoxHovered={blueBoxHovered} onBlueBoxHover={setBlueBoxHovered}
                photoBoxRef={photoBoxRef}
                photoBoxContent={<SimThumb srcRef={microSquareRef} opacity={effectiveThumbOpacity} />}
                capLength={capLength} capAngle={capAngle}
                onBoxClick={(box) => {
                  if (box === 'grey') setGreyLayoutSeed(s => s + 1)
                  handleBoxClick(box)
                }}
              />
            </div>
          </div>
        )}
      </main>

      {/* ── Histogram overlay (dev mode + runBreakTests data) ───────────── */}
      {showDevSliders && histRows && (() => {
        const W = 520, H = 280, ML = 44, MR = 16, MT = 24, MB = 36
        const iW = W - ML - MR, iH = H - MT - MB
        const values = histRows.filter(r => r.sand === `${histSandPct}%`).map(r => r.displayKN)
        if (!values.length) return null
        const avg    = values.reduce((a, b) => a + b, 0) / values.length
        const minV   = Math.min(...values), maxV = Math.max(...values)
        const binMin = Math.floor(minV / 100) * 100
        const binMax = Math.ceil((maxV + 1) / 100) * 100
        const bins   = []
        for (let b = binMin; b < binMax; b += 100)
          bins.push({ lo: b, hi: b + 100, n: values.filter(v => v >= b && v < b + 100).length })
        const maxN   = Math.max(...bins.map(b => b.n), 1)
        const xScale = iW / (binMax - binMin)
        const yScale = iH / maxN
        const xOf    = v => ML + (v - binMin) * xScale
        const yOf    = n => MT + iH - n * yScale
        const avgX   = xOf(avg)
        const yTicks = Array.from({ length: maxN + 1 }, (_, i) => i).filter(i => i % Math.ceil(maxN / 5) === 0 || i === maxN)
        const xTicks = bins.map(b => b.lo).concat(binMax)
        return (
          <div style={{
            position: 'fixed', top: 60, right: 24, zIndex: 9999,
            background: 'rgba(18,22,18,0.96)', border: '1px solid rgba(120,180,80,0.3)',
            borderRadius: 8, padding: '12px 16px', boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
            fontFamily: 'Lexend, system-ui, sans-serif', color: '#ccc',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 16 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#8ab868' }}>Break Force Distribution</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {SAND_PRESETS.map(pct => (
                  <button key={pct} onClick={() => setHistSandPct(pct)} style={{
                    padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                    background: histSandPct === pct ? '#4a7a30' : 'rgba(255,255,255,0.07)',
                    border: histSandPct === pct ? '1px solid #6aaa40' : '1px solid rgba(255,255,255,0.15)',
                    color: histSandPct === pct ? '#c8f0a0' : '#888',
                  }}>{pct}%</button>
                ))}
              </div>
            </div>
            <svg width={W} height={H}>
              {/* y gridlines + labels */}
              {yTicks.map(n => (
                <g key={n}>
                  <line x1={ML} x2={ML + iW} y1={yOf(n)} y2={yOf(n)} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
                  <text x={ML - 5} y={yOf(n) + 4} textAnchor="end" fontSize={9} fill="#666">{n}</text>
                </g>
              ))}
              {/* bars */}
              {bins.map(b => (
                <rect key={b.lo}
                  x={xOf(b.lo) + 1} y={yOf(b.n)}
                  width={Math.max(0, b.hi === binMax ? iW - (xOf(b.lo) - ML) - 1 : xScale - 2)}
                  height={b.n * yScale}
                  fill="rgba(100,180,60,0.55)" stroke="rgba(120,200,70,0.8)" strokeWidth={1}
                />
              ))}
              {/* x axis */}
              <line x1={ML} x2={ML + iW} y1={MT + iH} y2={MT + iH} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
              {xTicks.map(v => (
                <g key={v}>
                  <line x1={xOf(v)} x2={xOf(v)} y1={MT + iH} y2={MT + iH + 4} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
                  <text x={xOf(v)} y={MT + iH + 14} textAnchor="middle" fontSize={9} fill="#666">{v}</text>
                </g>
              ))}
              {/* x axis label */}
              <text x={ML + iW / 2} y={H - 2} textAnchor="middle" fontSize={9} fill="#555">kN</text>
              {/* y axis label */}
              <text x={10} y={MT + iH / 2} textAnchor="middle" fontSize={9} fill="#555" transform={`rotate(-90,10,${MT + iH / 2})`}>count</text>
              {/* average line */}
              <line x1={avgX} x2={avgX} y1={MT} y2={MT + iH} stroke="#f0c040" strokeWidth={1.5} strokeDasharray="4 3" />
              <text x={avgX + 4} y={MT + 11} fontSize={10} fill="#f0c040">avg {Math.round(avg)} kN</text>
              {/* n label */}
              <text x={ML + iW} y={MT + 11} textAnchor="end" fontSize={9} fill="#555">n={values.length}</text>
            </svg>
          </div>
        )
      })()}
    </div>
  )
}
