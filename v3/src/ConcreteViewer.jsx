import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import MacroPanel, { generateCrack } from './MacroPanel'
import { MicroPanelB, buildGrains, buildCrackWaypoints, VW, VH } from './MicroPanel'
import './ConcreteViewer.css'

const SAND_PRESETS = [0, 20, 40, 60, 80]
const SPEEDS = [0.25, 0.5, 1.0, 2.0, 4.0]

const PHASE1_RATIO    = 1.1
const PHASE1_STEPS    = 34
const PHASE2_STEPS    = 8
const PHASE1_DURATION = 700
const PHASE2_DURATION = 80

const PZL_IMG_H = 1687   // BeamTestNoBeam natural height
const SIM_ASPECT = VW / VH

const lerp = (a, b, t) => a + (b - a) * t

const BAR_IMG_AR = 372 / 1278   // BarAlone2.png naturalHeight/naturalWidth

const CRACK_SCALE   = 7    // magnification relative to red box size
const CRACK_Y_FAC  = 0.70  // macro renders crack at 70% of beam height
const CRACK_X_FAC  = 0.50  // macro horizontal spread factor

// Renders BarAlone.png with a quadratic downward bend.
// bend = right-edge drop as a fraction of the image's natural height.
// Left edge is pinned at y=0; each column x shifts down by bend*H*(x/W)^2.
function BentBar({ src, bend = 0, style }) {
  const canvasRef = useRef(null)
  const [img, setImg] = useState(null)

  useEffect(() => {
    const el = new Image()
    el.onload = () => setImg(el)
    el.src = src
  }, [src])

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
  }, [img, bend])

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

export default function ConcreteViewer() {
  const [sandPct, setSandPct] = useState(40)
  const [phase, setPhase]     = useState('idle')
  const [force, setForce]     = useState(1000 / 2500)
  const [layoutSeed, setLayoutSeed] = useState(0)
  const [speedIdx, setSpeedIdx]     = useState(2)

  const [bondRound]  = useState(3)
  const [arrowScale] = useState(2)
  const [hasRecording, setHasRecording] = useState(false)
  const [scrubT, setScrubT]             = useState(1)

  // Test scrub: checkbox shows/hides the replay slider
  const [testScrubOn, setTestScrubOn] = useState(false)
  const [showDevSliders, setShowDevSliders] = useState(false)
  const [capLength, setCapLength] = useState(15.2)
  const [capAngle,  setCapAngle]  = useState(33)

  const [crackParams, setCrackParams] = useState({
    0:  { depth: 1.24, dev: 0.00, segs: 1, branch: 0.03, widthMul: 2.23, speedMul: 1.0, taper: -0.25 },
    20: { depth: 1.21, dev: 0.140, segs: 1, branch: 0.14, widthMul: 1.8, speedMul: 2.9, taper: -0.55 },
    40: { depth: 0.67, dev: 0.565, segs: 1, branch: 0.13, widthMul: 1.6, speedMul: 1.0, taper: -0.45 },
    60: { depth: 0.6, dev: 0.21, segs: 1, branch: 0.83, widthMul: 0.7, speedMul: 1.0, taper: -0.5 },
    80: { depth: 1.15, dev: 0.43, segs: 1, branch: 0.77, widthMul: 6.0, speedMul: 1.7, taper: -0.6 },
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
  const [pusherY,    setPusherY]    = useState(-13)
  const [pusherSize, setPusherSize] = useState(25)
  const [barX,       setBarX]       = useState(21.9)
  const [barY,       setBarY]       = useState(8.6)
  const [barSize,    setBarSize]    = useState(70.4)

  const [photoView, setPhotoView] = useState('full')
  const [photoBoxX]    = useState(34.8)
  const [photoBoxY]    = useState(24.1)
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
  const photoStageRef  = useRef(null)
  const photoBoxRef    = useRef(null)
  const zoomTimerRef   = useRef(null)   // photo zoom advance loop
  const p2TimerRef     = useRef(null)   // phase-2 sim step timer
  const replayRef      = useRef(false)

  function cancelZoom() {
    clearTimeout(zoomTimerRef.current)
    clearTimeout(p2TimerRef.current)
    setPhotoView('off')
    setPhotoScale(1)
    setPhase1Step(0)
    setPhase2Step(0)
    setPhase2Active(false)
  }

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') cancelZoom() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    if (phase === 'idle' && replayRef.current) {
      replayRef.current = false
      const id = requestAnimationFrame(() => setPhase('testing'))
      return () => cancelAnimationFrame(id)
    }
  }, [phase])

  const grains = useMemo(
    () => buildGrains(sandPct, layoutSeed * 7919 + sandPct * 137 + 42),
    [sandPct, layoutSeed]
  )
  const crackWaypoints = useMemo(() => buildCrackWaypoints(grains, sandPct), [grains, sandPct])
  const crackPts = useMemo(
    () => crackWaypoints.map(pt => [pt.x / VW, pt.y / VH]),
    [crackWaypoints]
  )
  // Same seed as MacroPanel uses for its visible crack line
  const currentCrackParams = crackParams[sandPct]
  const macroCrackStrands = useMemo(
    () => generateCrack(sandPct, layoutSeed * 7919 + sandPct * 137, currentCrackParams),
    [sandPct, layoutSeed, currentCrackParams]
  )
  const totalCrackMs = macroCrackStrands.reduce((m, s) => Math.max(m, s.delayMs + s.durationMs), 0)

  // Among branch strands (fromTop:false), pick the one whose end-to-start direction is most vertical
  const bestBranch = useMemo(() => {
    const branches = macroCrackStrands.filter(s => !s.fromTop)
    if (!branches.length) return null
    return branches.reduce((best, s) => {
      const [x0, y0] = s.pts[0], [x1, y1] = s.pts[s.pts.length - 1]
      const cur  = Math.abs(y1 - y0) / (Math.abs(x1 - x0) + 0.001)
      const [bx0, by0] = best.pts[0], [bx1, by1] = best.pts[best.pts.length - 1]
      const prev = Math.abs(by1 - by0) / (Math.abs(bx1 - bx0) + 0.001)
      return cur > prev ? s : best
    })
  }, [macroCrackStrands])

  function clearRecording() { setHasRecording(false); setScrubT(1) }
  function startTest()  { clearRecording(); setLayoutSeed(s => s + 1); setPhase('testing'); setActiveBox('red') }
  function reset()      { clearRecording(); setPhase('idle'); setActiveBox('red') }
  function handleReplay() { clearRecording(); replayRef.current = true; setPhase('idle') }

  function handleSandPct(pct) {
    clearRecording(); setSandPct(pct); setPhase('idle'); setLayoutSeed(s => s + 1)
  }

  function handleRecordingReady() { setHasRecording(true) }
  function handleFailed()  { setPhase('failed') }
  function handleSettled() { setPhase('settled') }

  function handleBoxClick(box) {
    if (photoView !== 'full') return
    setActiveBox(box)
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

  const crackOriginY = photoBoxY - 1.2   // aligns with red box top (matches calc(photoBoxY% - 8px))

  let blueBoxPos = null
  if (bestBranch) {
    const [xnE, ynE] = bestBranch.pts[bestBranch.pts.length - 1]
    blueBoxPos = {
      x: photoBoxX + (xnE - 0.5) * CRACK_X_FAC * boxW * CRACK_SCALE,
      y: crackOriginY + ynE * CRACK_Y_FAC * boxH * CRACK_SCALE,
    }
  }
  const zoomOriginX = activeBox === 'blue' && blueBoxPos ? blueBoxPos.x : photoBoxX
  const zoomOriginY = activeBox === 'blue' && blueBoxPos ? blueBoxPos.y : photoBoxY + boxH / 2

  const inPhase2     = phase2Active
  const needsP2Xfrm  = inPhase2
  const showPhoto    = photoView !== 'off'
  const p1Frac       = phase1Step / PHASE1_STEPS

  // SimThumb fades from 0 at phase-1 midpoint to 1 at end; stays 1 once phase 1 completes
  const thumbOpacity = simReady
    ? 1
    : Math.max(0, Math.min(1, (p1Frac - 0.5) * 2))


  const borderPx = 2.5 / photoScale
  const photoBoxStyle = {
    left:          `${photoBoxX - boxW / 2}%`,
    top:           `calc(${photoBoxY}% - 8px)`,
    width:         `${boxW}%`,
    height:        `${boxH}%`,
    background:    `rgba(245,240,232,${simReady ? 1 : Math.max(0, (p1Frac - 0.5) * 2)})`,
    borderWidth:   `${borderPx}px`,
    borderColor:   boxHovered ? '#ff4444' : '#cc2222',
    boxShadow:     boxHovered
      ? `0 0 0 ${1/photoScale}px rgba(0,0,0,0.6), 0 0 ${16/photoScale}px rgba(200,30,30,0.9)`
      : `0 0 0 ${1/photoScale}px rgba(0,0,0,0.6), 0 0 ${8/photoScale}px rgba(200,30,30,0.5)`,
    pointerEvents: photoView === 'zooming' ? 'none' : 'auto',
  }

  // Phase-2 transform: moves/scales sim wrapper to match red box in photo, then back to normal.
  // Uses getBoundingClientRect so photo-stage and micro-square can have independent sizes.
  function computeP2Transform(p2T) {
    const psEl = photoStageRef.current   // photo stage (covers micro-section)
    const msEl = microSquareRef.current  // micro-square (sim host)
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

  const p2Transform = inPhase2
    ? computeP2Transform(phase2Step / PHASE2_STEPS)
    : 'none'

  // Effective bend anim: scrub follows scrubT when replaying, else ramp
  const effectiveBendAnim = testScrubOn && hasRecording ? scrubT : bendAnim

  // How much the pusher drops: quadratic drop at pusherX position within the bar,
  // converted from bar-natural-height fraction to photo-layer-height %
  const tPusher      = Math.max(0, Math.min(1, (pusherX - barX) / Math.max(barSize, 0.1)))
  const pusherDropPct = force * 0.04 * effectiveBendAnim * tPusher * tPusher
                        * barSize * BAR_IMG_AR * pzlAspect

  function strandToPhotoCapD(strand) {
    const [xn0] = strand.pts[0]
    const px0 = photoBoxX + (xn0 - 0.5) * CRACK_X_FAC * boxW * CRACK_SCALE
    const py0 = crackOriginY
    const capRad = capAngle * Math.PI / 180
    const capScale = CRACK_Y_FAC * CRACK_SCALE * boxH / 38
    const pex = px0 + Math.sin(capRad) * capLength * capScale
    const pey = py0 - Math.cos(capRad) * capLength * capScale
    return `M${px0.toFixed(2)},${py0.toFixed(2)} L${pex.toFixed(2)},${pey.toFixed(2)}`
  }
  // White trapezoid at the tip of the cap line — base = stroke width, tapers along cap direction
  function strandToCapTipD(strand, wm) {
    const [xn0] = strand.pts[0]
    const px0 = photoBoxX + (xn0 - 0.5) * CRACK_X_FAC * boxW * CRACK_SCALE
    const py0 = crackOriginY
    const capRad = capAngle * Math.PI / 180
    const capScale = CRACK_Y_FAC * CRACK_SCALE * boxH / 38
    const pex = px0 + Math.sin(capRad) * capLength * capScale
    const pey = py0 - Math.cos(capRad) * capLength * capScale
    const sinC = Math.sin(capRad), cosC = Math.cos(capRad)
    const hw = 0.125 * wm        // half base width = half cap stroke width
    const h  = wm * 1.5          // height along cap direction
    const tw = hw * 0.18         // half top edge (tiny flat, not a sharp point)
    const f  = n => n.toFixed(2)
    // base: perpendicular to cap at tip; top: slightly further along cap, narrow
    return `M${f(pex - cosC*hw)},${f(pey - sinC*hw)} ` +
           `L${f(pex + cosC*hw)},${f(pey + sinC*hw)} ` +
           `L${f(pex + sinC*h + cosC*tw)},${f(pey - cosC*h + sinC*tw)} ` +
           `L${f(pex + sinC*h - cosC*tw)},${f(pey - cosC*h - sinC*tw)} Z`
  }
  const showPhotoCracks = (phase === 'failed' || phase === 'settled') && macroCrackStrands.length > 0
  const showBlueCrack = showPhotoCracks && blueBoxPos !== null

  const simWrapperStyle = {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
    visibility: (!showPhoto || simReady || needsP2Xfrm) ? 'visible' : 'hidden',
    ...(needsP2Xfrm ? {
      position: 'relative',
      zIndex: 20,
      transform: p2Transform,
      transformOrigin: '50% 50%',
    } : {}),
  }

  return (
    <div className="viewer">
      <header className="top-bar">
        <div className="toolbar" style={{ flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 0 }}>
          {/* Row 1: controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="toolbar-label">Sand %</span>
            {SAND_PRESETS.map(pct => (
              <button key={pct}
                className={`preset-btn ${sandPct === pct ? 'active' : ''}`}
                onClick={() => handleSandPct(pct)}
              >{pct}%</button>
            ))}
            <div className="toolbar-divider" />
            <button className="action-btn test-btn"
              onClick={startTest} disabled={phase === 'testing'}>Test</button>
            <button className="action-btn reset-btn"
              onClick={reset} disabled={phase === 'idle'}>Reset</button>
            <button className="action-btn replay-btn"
              onClick={handleReplay} disabled={phase === 'idle' || phase === 'testing'}>Replay</button>
            <button className="action-btn photo-btn"
              onClick={() => photoView === 'off'
                ? (setPhotoView('full'), setPhotoScale(1), setPhase1Step(0), setSimReady(false))
                : cancelZoom()
              }>Photo</button>
            <div className="toolbar-divider" />
            <span className="toolbar-label speed-icon">🐢</span>
            <input type="range" className="speed-slider" min={0} max={4} step={1}
              value={speedIdx} onChange={e => setSpeedIdx(Number(e.target.value))} />
            <span className="toolbar-label speed-icon">🐇</span>
            <div className="toolbar-divider" />
            <label className="toolbar-label" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input type="checkbox" style={{ marginRight: 4 }}
                checked={testScrubOn}
                onChange={e => setTestScrubOn(e.target.checked)}
              />
              Scrub
            </label>
            <div className="toolbar-divider" />
            <label className="toolbar-label" style={{ cursor: 'pointer', whiteSpace: 'nowrap', color: '#666' }}>
              <input type="checkbox" style={{ marginRight: 4 }}
                checked={showDevSliders}
                onChange={e => setShowDevSliders(e.target.checked)}
              />
              Dev
            </label>
          </div>

          {/* Row 2: test replay slider — only when scrub is on */}
          {testScrubOn && (
            <div style={{ display: 'flex', alignItems: 'center', paddingTop: 3 }}>
              <input
                type="range"
                min={0} max={1} step={0.001}
                value={scrubT}
                disabled={!hasRecording}
                style={{ flex: 1, accentColor: '#a08060', cursor: hasRecording ? 'pointer' : 'default' }}
                onChange={e => setScrubT(Number(e.target.value))}
              />
            </div>
          )}

          {/* Rows 3-4: dev sliders (hidden by default) */}
          {showDevSliders && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 3 }}>
                <span className="toolbar-label" style={{ minWidth: 42 }}>Pusher</span>
                <span className="toolbar-label">X</span>
                <input type="range" min={0} max={100} step={0.1} value={pusherX}
                  style={{ width: 80, accentColor: '#7090b0' }} onChange={e => setPusherX(Number(e.target.value))} />
                <span className="toolbar-label">Y</span>
                <input type="range" min={-20} max={100} step={0.1} value={pusherY}
                  style={{ width: 80, accentColor: '#7090b0' }} onChange={e => setPusherY(Number(e.target.value))} />
                <span className="toolbar-label">Sz</span>
                <input type="range" min={1} max={60} step={0.1} value={pusherSize}
                  style={{ width: 80, accentColor: '#7090b0' }} onChange={e => setPusherSize(Number(e.target.value))} />
                <span className="toolbar-label" style={{ minWidth: 28, color: '#555' }}>{pusherX.toFixed(1)},{pusherY.toFixed(1)} {pusherSize.toFixed(1)}%</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 3 }}>
                <span className="toolbar-label" style={{ minWidth: 42 }}>Bar</span>
                <span className="toolbar-label">X</span>
                <input type="range" min={0} max={100} step={0.1} value={barX}
                  style={{ width: 80, accentColor: '#a07050' }} onChange={e => setBarX(Number(e.target.value))} />
                <span className="toolbar-label">Y</span>
                <input type="range" min={0} max={100} step={0.1} value={barY}
                  style={{ width: 80, accentColor: '#a07050' }} onChange={e => setBarY(Number(e.target.value))} />
                <span className="toolbar-label">Sz</span>
                <input type="range" min={1} max={100} step={0.1} value={barSize}
                  style={{ width: 80, accentColor: '#a07050' }} onChange={e => setBarSize(Number(e.target.value))} />
                <span className="toolbar-label" style={{ minWidth: 28, color: '#555' }}>{barX.toFixed(1)},{barY.toFixed(1)} {barSize.toFixed(1)}%</span>
                <div className="toolbar-divider" />
                <span className="toolbar-label">Photo↑</span>
                <input type="range" min={0} max={40} step={0.1} value={photoVShift}
                  style={{ width: 80, accentColor: '#70a080' }} onChange={e => setPhotoVShift(Number(e.target.value))} />
                <span className="toolbar-label" style={{ color: '#555' }}>{photoVShift.toFixed(1)}%</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 3 }}>
                <span className="toolbar-label" style={{ minWidth: 42 }}>Cap</span>
                <span className="toolbar-label">Len</span>
                <input type="range" min={0} max={30} step={0.1} value={capLength}
                  style={{ width: 80, accentColor: '#a060a0' }} onChange={e => setCapLength(Number(e.target.value))} />
                <span className="toolbar-label">Ang</span>
                <input type="range" min={-60} max={60} step={1} value={capAngle}
                  style={{ width: 80, accentColor: '#a060a0' }} onChange={e => setCapAngle(Number(e.target.value))} />
                <span className="toolbar-label" style={{ color: '#555' }}>{capLength.toFixed(1)} {capAngle}°</span>
              </div>
              {(() => {
                const ck = crackParams[sandPct]
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingTop: 3 }}>
                    <span className="toolbar-label" style={{ minWidth: 42, color: '#806040' }}>Crack {sandPct}%</span>
                    <span className="toolbar-label">Dep</span>
                    <input type="range" min={0.05} max={1.5} step={0.01} value={ck.depth}
                      style={{ width: 58, accentColor: '#c09050' }} onChange={e => setCK('depth', +e.target.value)} />
                    <span className="toolbar-label">Dev</span>
                    <input type="range" min={0} max={0.60} step={0.005} value={ck.dev}
                      style={{ width: 58, accentColor: '#c09050' }} onChange={e => setCK('dev', +e.target.value)} />
                    <span className="toolbar-label">Sprd</span>
                    <input type="range" min={0} max={1.0} step={0.005} value={ck.branch}
                      style={{ width: 58, accentColor: '#c09050' }} onChange={e => setCK('branch', +e.target.value)} />
                    <span className="toolbar-label">W</span>
                    <input type="range" min={0.3} max={8.0} step={0.05} value={ck.widthMul}
                      style={{ width: 46, accentColor: '#c09050' }} onChange={e => setCK('widthMul', +e.target.value)} />
                    <span className="toolbar-label">Spd</span>
                    <input type="range" min={0.1} max={4.0} step={0.05} value={ck.speedMul}
                      style={{ width: 46, accentColor: '#c09050' }} onChange={e => setCK('speedMul', +e.target.value)} />
                    <span className="toolbar-label">Tpr</span>
                    <input type="range" min={-1} max={2} step={0.05} value={ck.taper}
                      style={{ width: 58, accentColor: '#c09050' }} onChange={e => setCK('taper', +e.target.value)} />
                    <span className="toolbar-label" style={{ color: '#555', fontSize: 10, whiteSpace: 'nowrap' }}>
                      d{ck.depth.toFixed(2)} v{ck.dev.toFixed(3)} b{ck.branch.toFixed(2)} w{ck.widthMul.toFixed(1)} ×{ck.speedMul.toFixed(1)} t{ck.taper.toFixed(2)}
                    </span>
                  </div>
                )
              })()}
            </>
          )}
        </div>

        <div className="macro-thumb">
          <span className="panel-title">Macro</span>
          <MacroPanel
            phase={phase} force={force} onForceChange={setForce}
            sandPct={sandPct} crackPts={crackPts}
            layoutSeed={layoutSeed} arrowScale={arrowScale}
            capLength={capLength} capAngle={capAngle}
            crackGeom={currentCrackParams}
          />
        </div>
        {/* Live mini photo preview — same overlays as the main photo view */}
        <div className="beam-photo">
          <div style={{
            position: 'relative',
            aspectRatio: `3000 / ${PZL_IMG_H * (1 - cropFrac)}`,
            height: '100%',
            maxWidth: '100%',
            overflow: 'hidden',
          }}>
            <img src="/concrete/BeamTestNoBeam.png" draggable={false} style={{
              display: 'block', width: '100%', height: 'auto', userSelect: 'none',
              transform: `translateY(-${cropFrac * 100}%)`,
            }} />
            <BentBar src="/concrete/BarAlone2.png"
              bend={force * 0.04 * effectiveBendAnim}
              style={{ position: 'absolute', left: `${barX}%`, top: `${barY}%`, width: `${barSize}%`, pointerEvents: 'none', userSelect: 'none' }}
            />
            {showPhotoCracks && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
              >
                {macroCrackStrands.flatMap((strand, si) => {
                  const wm = currentCrackParams.widthMul
                  const tp = currentCrackParams.taper
                  const isScrubbable = testScrubOn && hasRecording
                  const elapsed = isScrubbable ? scrubT * totalCrackMs : null
                  const photoPts = strand.pts.map(([xn, yn]) => [
                    photoBoxX + (xn - 0.5) * CRACK_X_FAC * boxW * CRACK_SCALE,
                    crackOriginY + yn * CRACK_Y_FAC * boxH * CRACK_SCALE,
                  ])
                  const N = photoPts.length - 1
                  return [
                    ...(strand.fromTop ? [
                      <path key="cap" d={strandToPhotoCapD(strand)}
                        fill="none" stroke="#1a1008" strokeWidth={0.25 * wm} strokeLinecap="round" />,
                      <path key="captip" d={strandToCapTipD(strand, wm)} fill="#f5f0e8" stroke="none" />,
                    ] : []),
                    ...photoPts.slice(0, -1).map(([px0, py0], i) => {
                      const [px1, py1] = photoPts[i + 1]
                      const t = N <= 1 ? 0 : i / (N - 1)
                      const w = 0.25 * wm * Math.max(0.03, 1 + tp * t)
                      const segDur = strand.durationMs / N
                      const segDelay = strand.delayMs + i * segDur
                      const d = `M${px0.toFixed(2)},${py0.toFixed(2)} L${px1.toFixed(2)},${py1.toFixed(2)}`
                      const pathStyle = isScrubbable
                        ? { strokeDasharray: 1, strokeDashoffset: 1 - Math.max(0, Math.min(1, (elapsed - segDelay) / segDur)) }
                        : { animation: `draw-crack ${segDur}ms ease-out ${segDelay}ms forwards` }
                      return <path key={`${si}-${i}`} d={d} pathLength="1" className="crack"
                        fill="none" stroke="#1a1008" strokeWidth={w} strokeLinecap="round" style={pathStyle} />
                    }),
                  ]
                })}
              </svg>
            )}
            <img src="/concrete/Pusher.png" draggable={false} style={{
              position: 'absolute', left: `${pusherX}%`, top: `${pusherY + pusherDropPct}%`,
              width: `${pusherSize}%`, height: 'auto', transform: 'translateX(-50%)',
              pointerEvents: 'none', userSelect: 'none',
            }} />
          </div>
        </div>
      </header>

      <main className="micro-section">
        {photoView === 'off' && (
          <div className="force-viz-space">
            <span className="panel-title">Forces</span>
          </div>
        )}

        <div ref={microSquareRef} className="micro-square">
          <div style={simWrapperStyle}>
            {activeBox === 'blue' ? (
              <MicroPanelB
                sandPct={sandPct} phase="idle" layoutSeed={layoutSeed + 500}
                force={0} speed={1} bondRound={bondRound}
                crackWaypoints={[]}
                onSettled={() => {}} onFailed={() => {}}
                scrubT={null} onRecordingReady={() => {}}
              />
            ) : (
              <MicroPanelB
                sandPct={sandPct} phase={phase} layoutSeed={layoutSeed}
                force={force} speed={speed} bondRound={bondRound}
                crackWaypoints={crackWaypoints}
                onSettled={handleSettled} onFailed={handleFailed}
                scrubT={testScrubOn && hasRecording ? scrubT : null}
                onRecordingReady={handleRecordingReady}
              />
            )}
          </div>
        </div>

        {showPhoto && (
          <div ref={photoStageRef} className="photo-stage">
            <div
              className="photo-zoom-layer"
              style={{
                aspectRatio: `3000 / ${PZL_IMG_H * (1 - cropFrac)}`,
                transformOrigin: `50% 50%`,
                // translate keeps zoom target at viewport centre: as scale grows, the offset
                // from photo-centre to zoom-target is amplified, so we counter it exactly.
                transform: photoScale === 1
                  ? 'none'
                  : `translate(${-photoScale * (zoomOriginX - 50)}%, ${-photoScale * (zoomOriginY - 50)}%) scale(${photoScale})`,
                imageRendering: photoScale > 5 ? 'pixelated' : 'auto',
              }}
            >
              <img
                src="/concrete/BeamTestNoBeam.png"
                className="photo-img"
                draggable={false}
                style={{
                  display: 'block',
                  width: '100%',
                  height: 'auto',
                  transform: `translateY(-${cropFrac * 100}%)`,
                }}
              />
              {/* Bar overlay — bends down quadratically with force */}
              <BentBar
                src="/concrete/BarAlone2.png"
                bend={force * 0.04 * effectiveBendAnim}
                style={{
                  position: 'absolute',
                  left: `${barX}%`,
                  top: `${barY}%`,
                  width: `${barSize}%`,
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
              />

              {/* Crack overlay — drawn on top of bar surface */}
              {showPhotoCracks && (
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
                >
                  {macroCrackStrands.flatMap((strand, si) => {
                    const wm = currentCrackParams.widthMul
                    const tp = currentCrackParams.taper
                    const isScrubbable = testScrubOn && hasRecording
                    const elapsed = isScrubbable ? scrubT * totalCrackMs : null
                    const photoPts = strand.pts.map(([xn, yn]) => [
                      photoBoxX + (xn - 0.5) * CRACK_X_FAC * boxW * CRACK_SCALE,
                      crackOriginY + yn * CRACK_Y_FAC * boxH * CRACK_SCALE,
                    ])
                    const N = photoPts.length - 1
                    return [
                      ...(strand.fromTop ? [
                        <path key="cap" d={strandToPhotoCapD(strand)}
                          fill="none" stroke="#1a1008" strokeWidth={0.25 * wm} strokeLinecap="round" />,
                        <path key="captip" d={strandToCapTipD(strand, wm)} fill="#f5f0e8" stroke="none" />,
                      ] : []),
                      ...photoPts.slice(0, -1).map(([px0, py0], i) => {
                        const [px1, py1] = photoPts[i + 1]
                        const t = N <= 1 ? 0 : i / (N - 1)
                        const w = 0.25 * wm * Math.max(0.03, 1 + tp * t)
                        const segDur = strand.durationMs / N
                        const segDelay = strand.delayMs + i * segDur
                        const d = `M${px0.toFixed(2)},${py0.toFixed(2)} L${px1.toFixed(2)},${py1.toFixed(2)}`
                        const pathStyle = isScrubbable
                          ? { strokeDasharray: 1, strokeDashoffset: 1 - Math.max(0, Math.min(1, (elapsed - segDelay) / segDur)) }
                          : { animation: `draw-crack ${segDur}ms ease-out ${segDelay}ms forwards` }
                        return <path key={`${si}-${i}`} d={d} pathLength="1" className="crack"
                          fill="none" stroke="#1a1008" strokeWidth={w} strokeLinecap="round" style={pathStyle} />
                      }),
                    ]
                  })}
                </svg>
              )}

              {/* Pusher overlay */}
              <img
                src="/concrete/Pusher.png"
                draggable={false}
                style={{
                  position: 'absolute',
                  left: `${pusherX}%`,
                  top: `${pusherY + pusherDropPct}%`,
                  width: `${pusherSize}%`,
                  height: 'auto',
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
              />

              <div
                ref={photoBoxRef}
                className="photo-box"
                style={photoBoxStyle}
                onMouseEnter={() => setBoxHovered(true)}
                onMouseLeave={() => setBoxHovered(false)}
                onClick={() => handleBoxClick('red')}
              >
                <SimThumb srcRef={microSquareRef} opacity={thumbOpacity} />
              </div>

              {showBlueCrack && (
                <div
                  className="photo-box"
                  style={{
                    left:        `${blueBoxPos.x - boxW / 2}%`,
                    top:         `${blueBoxPos.y - boxH / 2}%`,
                    width:       `${boxW}%`,
                    height:      `${boxH}%`,
                    background:  'none',
                    borderWidth: `${borderPx}px`,
                    borderColor: blueBoxHovered ? '#4499ff' : '#2266cc',
                    boxShadow:   blueBoxHovered
                      ? `0 0 0 ${1/photoScale}px rgba(0,0,0,0.6), 0 0 ${16/photoScale}px rgba(30,100,220,0.9)`
                      : `0 0 0 ${1/photoScale}px rgba(0,0,0,0.6), 0 0 ${8/photoScale}px rgba(30,100,220,0.5)`,
                    pointerEvents: photoView === 'zooming' ? 'none' : 'auto',
                  }}
                  onMouseEnter={() => setBlueBoxHovered(true)}
                  onMouseLeave={() => setBlueBoxHovered(false)}
                  onClick={() => handleBoxClick('blue')}
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
