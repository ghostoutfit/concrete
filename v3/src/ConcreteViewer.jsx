import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { generateCrack } from './MacroPanel'
import { MicroPanelB, buildGrains, buildCrackWaypoints, buildBlueGrains, buildBlueCrackWaypoints, VW, VH } from './MicroPanel'
import './ConcreteViewer.css'

const SAND_PRESETS = [0, 20, 40, 60, 80]
const SPEEDS = [0.25, 0.5, 1.0, 2.0, 4.0]
const SAND_BREAK_KN  = { 0: 100, 20: 400, 40: 650, 60: 500, 80: 200 }
const SAND_BREAK_VAR = { 0: 0.10, 20: 0.10, 40: 0.10, 60: 0.10, 80: 0.20 }

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
const THUMB_CRACK_SCALE = 3   // smaller crack spread for mini thumbnail
const CRACK_Y_FAC  = 0.70  // macro renders crack at 70% of beam height
const CRACK_X_FAC  = 0.50  // macro horizontal spread factor

const BAR_SRCS = {
  0:  ['/concrete/0Sandbar.png',  null],
  20: ['/concrete/0Sandbar.png',  '/concrete/40Sandbar.png'],
  40: ['/concrete/40Sandbar.png', null],
  60: ['/concrete/40Sandbar.png', '/concrete/80Sandbar.png'],
  80: ['/concrete/80Sandbar.png', null],
}

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

const GREY_Y_EXTRA = 11  // zoom-layer % offset — grey box is this far below the red box

function ZoomHint({ x, y, color, circleSize, textBelow = false, extraUp = 0 }) {
  const fontSize = Math.max(9, circleSize * 0.52)
  const gap = circleSize / 2 + 4
  const textTransform = textBelow
    ? `translate(-50%, calc(50% + ${gap}px))`
    : `translate(-50%, calc(-50% - ${gap + extraUp}px))`
  return (
    <>
      <div style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        width: circleSize,
        height: circleSize,
        borderRadius: '50%',
        background: color,
        opacity: 0.38,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
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
  pusherX, pusherY,
  pusherSize,
  lcdX, lcdY, lcdKN, containerW,
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
}) {
  const crackOriginY = photoBoxY
  const circleSize = containerW * 2.5 * boxW / 100

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
                <path key="cap" d={strandToCapD(strand)}
                  fill="none" stroke="#1a1008" strokeWidth={0.3 * wm} strokeLinecap="butt" />,
                <path key="captip" d={strandToCapTipD(strand, wm)} fill="#f5f0e8" stroke="none" />,
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
        top: `${pusherY}%`,
        width: `${pusherSize}%`,
        height: 'auto',
        transform: 'translateX(-50%)',
        pointerEvents: 'none', userSelect: 'none',
      }} />
      <div style={{
        position: 'absolute', left: `${lcdX}%`, top: `${lcdY}%`,
        transform: 'translate(-50%, -50%) rotate(3deg)', zIndex: 20,
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
      {showPhotoCracks && showZoomUI && (
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
          />
        </>
      )}
    </>
  )
}

export default function ConcreteViewer() {
  const [sandPct, setSandPct] = useState(40)
  const [phase, setPhase]     = useState('idle')
  const [force, setForce]     = useState(1000 / 2500)
  const [layoutSeed, setLayoutSeed] = useState(0)
  const [speedIdx, setSpeedIdx]     = useState(2)

  const [bondRound]  = useState(3)
  const [hasRecording, setHasRecording] = useState(false)
  const [scrubT, setScrubT]             = useState(1)

  // Test scrub: checkbox shows/hides the replay slider
  const [showDevSliders, setShowDevSliders] = useState(false)
  const [zoomScrubT,  setZoomScrubT]  = useState(0)
  const [breakKN, setBreakKN] = useState(null)
  const [lcdKN, setLcdKN] = useState(0)
  const [lcdX, setLcdX] = useState(36.5)
  const [lcdY, setLcdY] = useState(60)
  const [capLength, setCapLength] = useState(15.2)
  const [capAngle,  setCapAngle]  = useState(33)
  const [p2StartFrac, setP2StartFrac] = useState(null)
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

  // LCD force ramp — mirrors MicroPanel's internal FORCE_RAMP_RATE (0.004/frame at 60fps)
  useEffect(() => {
    cancelAnimationFrame(lcdRafRef.current)
    if (phase === 'testing') {
      const kNPerMs = 0.004 * 60 * SPEEDS[speedIdx] * 2500 / 1000
      let last = null
      function tick(ts) {
        if (last === null) last = ts
        const dt = ts - last
        last = ts
        setLcdKN(prev => Math.min(2500, prev + kNPerMs * dt))
        lcdRafRef.current = requestAnimationFrame(tick)
      }
      lcdRafRef.current = requestAnimationFrame(tick)
    }
    return () => cancelAnimationFrame(lcdRafRef.current)
  }, [phase, speedIdx])

  // Per-sand break threshold: fires handleFailed when LCD crosses the target kN
  const breakThresholdRef = useRef(null)
  useEffect(() => { breakThresholdRef.current = null }, [sandPct])
  useEffect(() => {
    if (phase !== 'testing') return
    if (breakThresholdRef.current === null) {
      const base = SAND_BREAK_KN[sandPct] ?? 650
      const v = SAND_BREAK_VAR[sandPct] ?? 0.10
      breakThresholdRef.current = Math.round(base * (1 - v + Math.random() * 2 * v))
    }
    if (lcdKN >= breakThresholdRef.current) handleFailed(breakThresholdRef.current)
  }, [lcdKN, phase, sandPct])

  useEffect(() => {
    const el = zoomLayerRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setZoomLayerW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Overlay image positioning
  const [pusherX,    setPusherX]    = useState(75.3)
  const [pusherY,    setPusherY]    = useState(-13)
  const [pusherSize, setPusherSize] = useState(25)
  const [barX,       setBarX]       = useState(21.9)
  const [barY,       setBarY]       = useState(8.6)
  const [barSize,    setBarSize]    = useState(70.4)

  const [photoView, setPhotoView] = useState('full')
  const [showZoomUI, setShowZoomUI] = useState(true)
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
  const [blueLayoutSeed,   setBlueLayoutSeed]   = useState(1)
  const [blueHasRecording, setBlueHasRecording] = useState(false)
  const [greyLayoutSeed,   setGreyLayoutSeed]   = useState(1)
  const photoStageRef  = useRef(null)
  const photoBoxRef    = useRef(null)
  const zoomLayerRef   = useRef(null)
  const [zoomLayerW,   setZoomLayerW] = useState(800)
  const zoomTimerRef   = useRef(null)
  const p2TimerRef     = useRef(null)
  const replayRef      = useRef(false)
  const lcdRafRef      = useRef(null)
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
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      buf = (buf + e.key.toLowerCase()).slice(-3)
      if (buf === 'dev') { setShowDevSliders(d => !d); buf = '' }
    }
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

  const blueGrains = useMemo(
    () => buildBlueGrains(sandPct, blueLayoutSeed * 7919 + sandPct * 137 + 42),
    [sandPct, blueLayoutSeed]
  )
  const blueCrackWaypoints = useMemo(() => buildBlueCrackWaypoints(blueGrains), [blueGrains])

  const currentCrackParams = crackParams[sandPct]
  const macroCrackStrands = useMemo(
    () => generateCrack(sandPct, layoutSeed * 7919 + sandPct * 137, currentCrackParams),
    [sandPct, layoutSeed, currentCrackParams]
  )
  const totalCrackMs = macroCrackStrands.reduce((m, s) => Math.max(m, s.delayMs + s.durationMs), 0)

  const isScrubbable = photoView === 'off' && hasRecording
  const scrubElapsed = isScrubbable
    ? (p2StartFrac != null
      ? Math.max(0, Math.min(1, (scrubT - p2StartFrac) / (1 - p2StartFrac))) * totalCrackMs
      : scrubT * totalCrackMs)
    : null

  // Blue box: place at deepest fromTop strand endpoint, only when crack doesn't go all the way through
  const bestBranch = useMemo(() => {
    if (currentCrackParams.depth >= 1.0) return null
    const fromTop = macroCrackStrands.filter(s => s.fromTop)
    if (!fromTop.length) return null
    return fromTop.reduce((best, s) =>
      s.pts[s.pts.length - 1][1] > best.pts[best.pts.length - 1][1] ? s : best
    )
  }, [macroCrackStrands, currentCrackParams.depth])

  function clearRecording() { setHasRecording(false); setScrubT(1) }
  function startTest()  { breakFiredRef.current = false; breakThresholdRef.current = null; clearRecording(); setLayoutSeed(s => s + 1); setBlueLayoutSeed(s => s + 1); setPhase('testing'); setBluePhase('testing'); setActiveBox('red'); setForce(1); setLcdKN(0); setBreakKN(null); setBlueHasRecording(false); setP2StartFrac(null) }
  function reset()      { breakFiredRef.current = false; clearRecording(); setPhase('idle'); setBluePhase('idle'); setActiveBox('red'); setLcdKN(0); setBreakKN(null); setBlueHasRecording(false); setP2StartFrac(null) }
  function handleReplay() { clearRecording(); replayRef.current = true; setPhase('idle') }

  function handleSandPct(pct) {
    clearRecording(); setSandPct(pct); setPhase('idle'); setLayoutSeed(s => s + 1); setBreakKN(null)
  }

  function handleRecordingReady(p2Frac) { setHasRecording(true); if (p2Frac != null) setP2StartFrac(p2Frac) }
  function handleFailed(kn)  {
    if (breakFiredRef.current) return
    breakFiredRef.current = true
    setPhase('failed'); setBreakKN(kn ?? null); if (kn != null) setLcdKN(kn)
  }
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
  const effectiveBendAnim = photoView === 'off' && hasRecording ? scrubT : bendAnim

  // How much the pusher drops: quadratic drop at pusherX position within the bar,
  // converted from bar-natural-height fraction to photo-layer-height %
  const tPusher      = Math.max(0, Math.min(1, (pusherX - barX) / Math.max(barSize, 0.1)))
  const pusherDropPct = force * 0.04 * effectiveBendAnim * tPusher * tPusher
                        * barSize * BAR_IMG_AR * pzlAspect

  const showPhotoCracks = phase === 'failed' && macroCrackStrands.length > 0
  const showBlueCrack = showPhotoCracks && blueBoxPos !== null

  const effectiveSimReady = showDevSliders ? zoomScrubT > 0.5 : simReady
  const simWrapperStyle = {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
    visibility: (!showPhoto || (activeBox !== 'grey' && (effectiveSimReady || needsP2Xfrm))) ? 'visible' : 'hidden',
    ...(needsP2Xfrm ? {
      position: 'relative',
      zIndex: 20,
      transform: p2Transform,
      transformOrigin: '50% 50%',
    } : {}),
  }
  const blueWrapperStyle = {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
  }

  return (
    <div className="viewer">
      <header className="top-bar">
        <div className="toolbar" style={{ flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 0, position: 'relative' }}>
          <div className="panel-bolt" style={{ top: 9, left: 9 }} />
          <div className="panel-bolt" style={{ top: 9, right: 9 }} />
          <div className="panel-bolt" style={{ bottom: 9, left: 9 }} />
          <div className="panel-bolt" style={{ bottom: 9, right: 9 }} />
          {/* Heading row */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', paddingBottom: 4 }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#8a6a0a' }}>% Sand</span>
            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5a7888', marginLeft: 3 }}>/ Cement</span>
          </div>

          {/* Row 1: sand presets + Test/ZoomOut */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            {SAND_PRESETS.map(pct => (
              <button key={pct}
                className={`preset-btn ${sandPct === pct ? 'active' : ''}`}
                onClick={() => handleSandPct(pct)}
              >
                <span style={{ color: '#c8a020' }}>{pct}</span><span style={{ color: '#6a8898' }}>/{100 - pct}</span>
              </button>
            ))}
            <div className="toolbar-divider" />
            {photoView === 'off' ? (
              <button className="action-btn replay-btn" onClick={zoomOut}>Zoom Out</button>
            ) : (
              <>
                <button className="action-btn test-btn"
                  onClick={startTest} disabled={phase === 'testing'}>Test</button>
                <label className="zoom-checkbox-label">
                  <input
                    type="checkbox"
                    className="zoom-checkbox"
                    checked={showZoomUI}
                    onChange={e => setShowZoomUI(e.target.checked)}
                  />
                  <span>Zoom</span>
                </label>
              </>
            )}
          </div>

          {/* Row 2: Replay + scrub — micro view only */}
          {photoView === 'off' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 4 }}>
              <button className="action-btn replay-btn"
                onClick={handleReplay} disabled={phase === 'idle' || phase === 'testing'}>Replay</button>
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

          {/* Row 3: zoom scrub slider */}
          {showDevSliders && (
            <div style={{ display: 'flex', alignItems: 'center', paddingTop: 3 }}>
              <input
                type="range"
                min={0} max={1} step={0.001}
                value={zoomScrubT}
                disabled={!showPhoto}
                style={{ flex: 1, accentColor: '#6080a0', cursor: showPhoto ? 'pointer' : 'default' }}
                onChange={e => setZoomScrubT(Number(e.target.value))}
              />
            </div>
          )}

          {/* Rows 3-4: dev sliders (hidden by default) */}
          {showDevSliders && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 3 }}>
                <span className="toolbar-label" style={{ minWidth: 42 }}>LCD</span>
                <span className="toolbar-label">X</span>
                <input type="range" min={0} max={100} step={0.5} value={lcdX}
                  style={{ width: 80, accentColor: '#40c8a0' }} onChange={e => setLcdX(Number(e.target.value))} />
                <span className="toolbar-label">Y</span>
                <input type="range" min={0} max={100} step={0.5} value={lcdY}
                  style={{ width: 80, accentColor: '#40c8a0' }} onChange={e => setLcdY(Number(e.target.value))} />
                <span className="toolbar-label" style={{ color: '#555' }}>{lcdX.toFixed(1)},{lcdY.toFixed(1)}</span>
              </div>
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

        {/* Live mini photo preview — always in sync with main photo */}
        <div className="beam-photo">
          <div
            style={{
              position: 'relative',
              width: '100%',
              overflow: 'hidden',
              aspectRatio: `3000 / ${PZL_IMG_H * (1 - cropFrac)}`,
              cursor: photoView === 'off' ? 'zoom-out' : 'default',
            }}
            onClick={() => { if (photoView === 'off') zoomOut() }}
          >
            <PhotoScene
              cropFrac={cropFrac}
              sandPct={sandPct} barX={barX} barY={barY} barSize={barSize}
              bend={force * 0.04 * effectiveBendAnim}
              macroCrackStrands={macroCrackStrands} currentCrackParams={currentCrackParams}
              photoBoxX={photoBoxX}
              boxW={boxW} boxH={boxH}
              crackScale={THUMB_CRACK_SCALE}
              scrubElapsed={scrubElapsed}
              pusherX={pusherX} pusherY={pusherY + pusherDropPct}
              pusherSize={pusherSize}
              lcdX={lcdX} lcdY={lcdY} lcdKN={lcdKN} containerW={280}
              showPhotoCracks={showPhotoCracks} showBlueCrack={showBlueCrack}
              photoViewIsZooming={photoView === 'zooming'}
              photoBoxY={photoBoxY} blueBoxPos={blueBoxPos} greyBoxX={greyBoxX}
              showZoomUI={showZoomUI}
              borderPx={2}
              effectivePhotoScale={1}
              effectiveBoxBgAlpha={0}
              capLength={capLength} capAngle={capAngle}
              onBoxClick={(box) => {
                if (photoView === 'full') {
                  if (box === 'grey') setGreyLayoutSeed(s => s + 1)
                  handleBoxClick(box)
                } else if (photoView === 'off') {
                  zoomOut()
                }
              }}
              boxCursor={photoView === 'off' ? 'zoom-out' : 'zoom-in'}
            />
          </div>
        </div>
      </header>

      <main className="micro-section">
        {photoView === 'off' && activeBox !== 'grey' && (
          <div className="force-viz-space">
            <span className="panel-title">Forces</span>
          </div>
        )}

        {/* Red view */}
        <div ref={microSquareRef} className="micro-square" style={{ borderTop: '2px solid rgba(255,80,80,0.5)', display: photoView === 'off' && activeBox !== 'red' ? 'none' : undefined }}>
          <div style={simWrapperStyle}>
            <MicroPanelB
              sandPct={sandPct} phase={phase} layoutSeed={layoutSeed}
              force={force} speed={speed} bondRound={bondRound}
              crackWaypoints={crackWaypoints}
              label="Matrix crack"
              onSettled={handleSettled} onFailed={handleFailed}
              scrubT={photoView === 'off' && hasRecording ? scrubT : null}
              onRecordingReady={handleRecordingReady}
            />
          </div>
        </div>

        {/* Blue view — big grain stops crack */}
        <div ref={blueSquareRef} className="micro-square" style={{ borderTop: '2px solid rgba(80,140,255,0.5)', display: photoView === 'off' && activeBox !== 'blue' ? 'none' : undefined }}>
          <div style={blueWrapperStyle}>
            <MicroPanelB
              sandPct={sandPct} phase={bluePhase} layoutSeed={blueLayoutSeed}
              force={force} speed={speed} bondRound={bondRound}
              grainOverride={blueGrains}
              crackWaypoints={blueCrackWaypoints}
              accentColor="#3d6fd4"
              label="Grain arrest"
              onSettled={() => setBluePhase('settled')} onFailed={() => setBluePhase('failed')}
              scrubT={photoView === 'off' && blueHasRecording ? scrubT : null}
              onRecordingReady={() => setBlueHasRecording(true)}
            />
          </div>
        </div>

        {/* Grey view — static cross-section under pusher, always idle, never breaks */}
        <div className="micro-square" style={{ borderTop: '2px solid rgba(10,10,10,0.9)', display: photoView === 'off' && activeBox === 'grey' ? undefined : 'none' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <MicroPanelB
              sandPct={sandPct} phase="idle" layoutSeed={greyLayoutSeed}
              force={0} speed={1} bondRound={bondRound}
              accentColor="#111111"
              label="Cross-section"
              onSettled={() => {}} onFailed={() => {}}
              scrubT={null}
              onRecordingReady={() => {}}
            />
          </div>
        </div>

        {showPhoto && (
          <div ref={photoStageRef} className="photo-stage">
            <div
              ref={zoomLayerRef}
              className="photo-zoom-layer"
              style={{
                aspectRatio: `3000 / ${PZL_IMG_H * (1 - cropFrac)}`,
                transformOrigin: `50% 50%`,
                // translate keeps zoom target at viewport centre: as scale grows, the offset
                // from photo-centre to zoom-target is amplified, so we counter it exactly.
                transform: effectivePhotoScale === 1
                  ? 'none'
                  : `translate(${-effectivePhotoScale * (zoomOriginX - 50)}%, ${-effectivePhotoScale * (zoomOriginY - 50)}%) scale(${effectivePhotoScale})`,
                imageRendering: effectivePhotoScale > 5 ? 'pixelated' : 'auto',
              }}
            >
              <PhotoScene
                cropFrac={cropFrac}
                sandPct={sandPct} barX={barX} barY={barY} barSize={barSize}
                bend={force * 0.04 * effectiveBendAnim}
                macroCrackStrands={macroCrackStrands} currentCrackParams={currentCrackParams}
                photoBoxX={photoBoxX}
                boxW={boxW} boxH={boxH}
                crackScale={CRACK_SCALE}
                scrubElapsed={scrubElapsed}
                pusherX={pusherX} pusherY={pusherY + pusherDropPct}
                pusherSize={pusherSize}
                lcdX={lcdX} lcdY={lcdY} lcdKN={lcdKN} containerW={zoomLayerW}
                showPhotoCracks={showPhotoCracks} showBlueCrack={showBlueCrack}
                photoViewIsZooming={photoView === 'zooming'}
                photoBoxY={photoBoxY} blueBoxPos={blueBoxPos} greyBoxX={greyBoxX}
              showZoomUI={showZoomUI}
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
    </div>
  )
}
