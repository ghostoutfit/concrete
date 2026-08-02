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
  const [force, setForce]     = useState(1000 / 1500)
  const [layoutSeed, setLayoutSeed] = useState(0)
  const [speedIdx, setSpeedIdx]     = useState(2)

  const [bondRound]  = useState(3)
  const [arrowScale] = useState(2)
  const [hasRecording, setHasRecording] = useState(false)
  const [scrubT, setScrubT]             = useState(1)

  // Test scrub: checkbox shows/hides the replay slider
  const [testScrubOn, setTestScrubOn] = useState(false)

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
  const macroCrackPts = useMemo(
    () => generateCrack(sandPct, layoutSeed * 7919 + sandPct * 137),
    [sandPct, layoutSeed]
  )

  function clearRecording() { setHasRecording(false); setScrubT(1) }
  function startTest()  { clearRecording(); setPhase('testing') }
  function reset()      { clearRecording(); setPhase('idle') }
  function handleReplay() { clearRecording(); replayRef.current = true; setPhase('idle') }

  function handleSandPct(pct) {
    clearRecording(); setSandPct(pct); setPhase('idle'); setLayoutSeed(s => s + 1)
  }

  function handleRecordingReady() { setHasRecording(true) }
  function handleFailed()  { setPhase('failed') }
  function handleSettled() { setPhase('settled') }

  function handleBoxClick() {
    if (photoView !== 'full') return
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
    top:           `${photoBoxY}%`,
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
    const boxCX = pzlL + photoBoxX / 100 * pzlW
    const boxCY = pzlT + (photoBoxY + boxH / 2) / 100 * pzlH

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

  // Crack overlay on photo: macro crack line anchored at top-middle of red box,
  // scaled using same factors as MacroPanel (x*0.50, y*0.70 of beam height).
  let photoCrackD = null
  if ((phase === 'failed' || phase === 'settled') && macroCrackPts.length > 1) {
    const [cx0] = macroCrackPts[0]
    const pts = macroCrackPts.map(([x, y]) => [
      photoBoxX + (x - cx0) * CRACK_X_FAC * boxW * CRACK_SCALE,
      photoBoxY + y * CRACK_Y_FAC * boxH * CRACK_SCALE,
    ])
    photoCrackD = 'M ' + pts.map(([x, y]) => `${x},${y}`).join(' L ')
  }

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

          {/* Row 3: pusher overlay controls */}
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

          {/* Row 4: bar overlay controls + photo v-shift */}
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
        </div>

        <div className="macro-thumb">
          <span className="panel-title">Macro</span>
          <MacroPanel
            phase={phase} force={force} onForceChange={setForce}
            sandPct={sandPct} crackPts={crackPts}
            layoutSeed={layoutSeed} arrowScale={arrowScale}
          />
        </div>
        <div className="beam-photo">
          <img src="/concrete/BeamTestNoBeam.png" alt="Beam test apparatus" />
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
            <MicroPanelB
              sandPct={sandPct} phase={phase} layoutSeed={layoutSeed}
              force={force} speed={speed} bondRound={bondRound}
              crackWaypoints={crackWaypoints}
              onSettled={handleSettled} onFailed={handleFailed}
              scrubT={testScrubOn && hasRecording ? scrubT : null}
              onRecordingReady={handleRecordingReady}
            />
          </div>
        </div>

        {showPhoto && (
          <div ref={photoStageRef} className="photo-stage">
            <div
              className="photo-zoom-layer"
              style={{
                aspectRatio: `3000 / ${PZL_IMG_H * (1 - cropFrac)}`,
                transformOrigin: `${photoBoxX}% ${photoBoxY + boxH / 2}%`,
                transform: `scale(${photoScale})`,
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
              {photoCrackD && (
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
                >
                  <path d={photoCrackD} pathLength="1" className="crack" style={{ animationDuration: '0.7s' }}
                    fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="0.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d={photoCrackD} pathLength="1" className="crack" style={{ animationDuration: '0.7s' }}
                    fill="none" stroke="#111" strokeWidth="0.17" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
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
                onClick={handleBoxClick}
              >
                <SimThumb srcRef={microSquareRef} opacity={thumbOpacity} />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
