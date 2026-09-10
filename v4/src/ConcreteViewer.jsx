import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { generateCrack } from './MacroPanel'
import { MicroPanelB, BondIcon, buildGrains, buildBlueGrains, buildBlueCrackWaypoints, VW, VH, buildPhysics, stepPhysics, snapshotP1, MAX_PUNCH_DISP, buildIons, buildLattice, FRACTURE_THRESHOLD, strainColor, COLOR_STOPS, COLOR_STOPS_LIGHT, MATRIX_SPACING } from './MicroPanel'
import './ConcreteViewer.css'

const SAND_PRESETS = [0, 20, 40, 60, 80]
const SPEEDS = [0.25, 0.5, 1.0, 2.0, 4.0]
const MANUAL_SAND_PCT = 40
const MANUAL_FORCE_STEP = 20
const MANUAL_MAX_N = 600   // 30 steps of 20N; break at ~40% happens around 240-360N in practice
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
const THUMB_CRACK_SCALE = 7   // match main photo crack scale
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
  pusherX, pusherY,
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
                  fill="none" stroke="#1a1008" strokeWidth={0.3 * wm} strokeLinecap="butt" />,
                <path key={`${si}-captip`} d={strandToCapTipD(strand, wm)} fill="#f5f0e8" stroke="none" />,
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
  const [zoomScrubT,  setZoomScrubT]  = useState(0)
  const [breakKN, setBreakKN] = useState(null)
  const [lcdKN, setLcdKN] = useState(0)
  const [lcdX, setLcdX] = useState(36.5)
  const [lcdY, setLcdY] = useState(60)
  const [capLength, setCapLength] = useState(10.5)
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

  // Overlay image positioning
  const [pusherX,    setPusherX]    = useState(75.3)
  const [pusherY,    setPusherY]    = useState(-13)
  const [pusherSize, setPusherSize] = useState(25)
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
  const zoomTimerRef   = useRef(null)
  const p2TimerRef     = useRef(null)
  const replayRef      = useRef(false)
  const blueReplayRef  = useRef(false)
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
    if (controlTab !== 'manual') return
    setManualRecording(null)
    setManualBreakN(null)
    if (controlTab === 'manual') setManualForceN(0)

    const g = buildGrains(sandPct, layoutSeed * 7919 + sandPct * 137 + 42)
    const ions = buildIons(g)
    const lattices = g.map(buildLattice)
    const phys = buildPhysics(ions, g, lattices, (crackParams[sandPct] ?? crackParams[40]).widthMul * 1.5)

    const recording = []
    let foundBreakN = null

    for (let n = 0; n <= MANUAL_MAX_N; n += MANUAL_FORCE_STEP) {
      const f = n / MANUAL_MAX_N
      // Pre-set displacement so stepPhysics doesn't ramp — it runs kinematic + relaxation instantly
      phys.currentDisp = f * MAX_PUNCH_DISP
      const canBreak = f >= FRACTURE_THRESHOLD
      stepPhysics(phys, f, 1, canBreak)

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
  const isScrubbable = photoView === 'off' && (!isManual ? hasRecording : (manualInP2 && manualP2T >= 1))

  // Manual mode: compute scrubT into the preloaded recording
  const manualScrubT = useMemo(() => {
    if (controlTab !== 'manual' || !manualRecording?.length) return 0
    // Phase 1 frames have forceN set; spring-back frames don't
    const p1Count = manualRecording.filter(s => s.forceN != null).length
    const totalFrames = manualRecording.length
    const p2Count = totalFrames - p1Count
    if (manualBreakN == null || manualForceN < manualBreakN) {
      // Phase 1: force wiper — button position maps to strained frame
      const idx = Math.min(Math.round(manualForceN / MANUAL_FORCE_STEP), p1Count - 1)
      return idx / (totalFrames - 1)
    } else {
      // Phase 2: auto-play drives the frame; manualP2T stays at 1 when done
      const p2Idx = Math.round(manualP2T * (p2Count - 1))
      const frameIdx = p1Count + p2Idx
      return Math.min(1, frameIdx / (totalFrames - 1))
    }
  }, [controlTab, manualRecording, manualForceN, manualBreakN, manualP2T])

  const scrubElapsed = isManual
    ? (manualInP2 ? manualP2T * totalCrackMs : 0)
    : (isScrubbable
        ? (p2StartFrac != null
            ? Math.max(0, Math.min(1, (scrubT - p2StartFrac) / (1 - p2StartFrac))) * totalCrackMs
            : scrubT * totalCrackMs)
        : null)

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
  function startTest()  { breakFiredRef.current = false; clearRecording(); setPhase('testing'); setBluePhase('testing'); setActiveBox('red'); setForce(1); setLcdKN(0); setBreakKN(null); setBlueHasRecording(false); setP2StartFrac(null); setInitialBondCounts(bondCounts) }
  function reset()      { breakFiredRef.current = false; clearRecording(); setPhase('idle'); setBluePhase('idle'); setActiveBox('red'); setLcdKN(0); setBreakKN(null); setBlueHasRecording(false); setP2StartFrac(null); setLayoutSeed(Math.round(Math.random() * 1e6)); setBlueLayoutSeed(Math.round(Math.random() * 1e6)); setGreyLayoutSeed(Math.round(Math.random() * 1e6)); setInitialBondCounts(null) }
  function handleReplay() {
    breakFiredRef.current = false
    setLcdKN(0)
    clearRecording()
    setBlueHasRecording(false)
    blueReplayRef.current = true
    setBluePhase('idle')
    replayRef.current = true
    setPhase('idle')
  }

  function handleSandPct(pct) {
    clearRecording(); setSandPct(pct); setPhase('idle'); setLayoutSeed(Math.round(Math.random() * 1e6)); setGreyLayoutSeed(Math.round(Math.random() * 1e6)); setBreakKN(null); setInitialBondCounts(null); setManualRecording(null); setManualForceN(0); setManualBreakN(null); setManualP2T(0)
  }

  function handleRecordingReady(p2Frac) { setHasRecording(true); if (p2Frac != null) setP2StartFrac(p2Frac) }
  function handleFailed(kn)  {
    if (breakFiredRef.current) return
    breakFiredRef.current = true
    setPhase('failed'); setBreakKN(kn ?? null)
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

  const panelForce = isManual ? manualNormForce : force

  // Effective bend anim: 1.0 in manual mode (force directly controls bend), else scrub or ramp
  const effectiveBendAnim = isManual ? 1.0 : (photoView === 'off' && hasRecording ? scrubT : bendAnim)

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
        <div className="toolbar" style={{ flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 0, position: 'relative', paddingBottom: 36 }}>
          <div className="panel-bolt" style={{ top: 9, left: 9 }} />
          <div className="panel-bolt" style={{ top: 9, right: 9 }} />
          <div className="panel-bolt" style={{ bottom: 9, left: 9 }} />
          <div className="panel-bolt" style={{ bottom: 9, right: 9 }} />
          {/* Scrub slider + replay — sits between the bottom bolts; hidden in manual mode */}
          <div style={{ position: 'absolute', bottom: 2, left: 50, right: 70, display: isManual ? 'none' : 'flex', alignItems: 'center', gap: 50 }}>
            <div style={{ flex: 1, minWidth: 0, pointerEvents: activeHasRecording ? 'auto' : 'none' }}>
              <ScrubSlider value={scrubT} onChange={setScrubT} disabled={!activeHasRecording} />
            </div>
            <button
              className="action-btn test-btn"
              onClick={() => setScrubT(0)}
              disabled={!activeHasRecording}
              style={{ flexShrink: 0 }}
            >↺ Replay</button>
          </div>
          {/* Tab strip */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 2, marginBottom: 5 }}>
            <button
              className={`tab-btn ${controlTab === 'ratio' ? 'active' : ''}`}
              onClick={() => setControlTab('ratio')}
            >Sand:Cement Ratio</button>
            <button
              className={`tab-btn ${controlTab === 'manual' ? 'active' : ''}`}
              onClick={() => { setControlTab('manual'); setManualForceN(0); if (photoView !== 'off') cancelZoom() }}
            >Manual Force Values</button>
          </div>

          {controlTab === 'ratio' ? (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
              {/* Sand preset group — heading centered only on presets */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#8a6a0a' }}>% Sand</span>
                  <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5a7888', marginLeft: 3 }}>/ Cement</span>
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
              <div className="toolbar-divider" />
              {phase === 'failed' || phase === 'settled'
                ? <button className="action-btn test-btn" onClick={() => handleSandPct(sandPct)}>Reset</button>
                : <button className="action-btn test-btn" onClick={startTest} disabled={phase === 'testing'}>Test</button>
              }
              <div className="toolbar-divider" />
              {photoView === 'off' ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'rgba(200,215,230,0.45)' }}>Show/Hide Visuals</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <button className={`action-btn replay-btn${showCount ? ' active' : ''}`} onClick={() => setShowCount(f => !f)}>Count</button>
                    <button className={`action-btn replay-btn${chargeVisible ? ' active' : ''}`} onClick={() => setChargeVisible(f => !f)}>Charge</button>
                    <button className={`action-btn replay-btn${showField ? ' active' : ''}`} onClick={() => setShowField(f => !f)}>Field</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <button className="action-btn" style={{ background: 'rgba(200,40,40,0.25)', borderColor: 'rgba(200,60,60,0.6)', color: '#ff8888' }} onClick={() => handleBoxClick('red')}>Crack Start</button>
                  <button className="action-btn" style={{ background: 'rgba(20,20,20,0.4)', borderColor: 'rgba(80,80,80,0.6)', color: '#bbb' }} onClick={() => handleBoxClick('grey')}>Crack End</button>
                  <button className="action-btn" style={{ background: 'rgba(40,80,200,0.25)', borderColor: 'rgba(60,120,220,0.6)', color: '#88aaff' }} onClick={() => handleBoxClick('blue')}>Compress</button>
                </div>
              )}
              <div className="toolbar-divider" />
              {/* Right: theme toggle + speed slider */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4 }}>
                <button
                  className={`action-btn replay-btn${!darkMode ? ' active' : ''}`}
                  onClick={() => setDarkMode(f => !f)}
                  title="Toggle light/dark mode"
                  style={{
                    fontSize: 18,
                    padding: '3px 9px 4px',
                    lineHeight: 1,
                    textShadow: darkMode
                      ? '0 0 8px rgba(180,210,255,0.95), 0 0 18px rgba(120,170,255,0.6)'
                      : '0 0 8px rgba(255,220,50,0.95), 0 0 18px rgba(255,160,0,0.65)',
                  }}
                >{darkMode ? '☽' : '☀'}</button>
                <div className="toolbar-divider" />
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <span style={{ fontSize: 8, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(200,215,230,0.45)' }}>Speed</span>
                  <input
                    type="range" min={0} max={SPEEDS.length - 1} step={1}
                    value={speedIdx}
                    onChange={e => setSpeedIdx(Number(e.target.value))}
                    style={{ width: 72, accentColor: '#5a90d0' }}
                  />
                  <span style={{ fontSize: 8, letterSpacing: '0.06em', color: 'rgba(200,215,230,0.55)', fontVariantNumeric: 'tabular-nums' }}>{SPEEDS[speedIdx]}×</span>
                </div>
              </div>
            </div>
          ) : !manualRecording ? (
            <div style={{ color: 'rgba(200,215,230,0.55)', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textAlign: 'center' }}>
              Loading…
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
              {/* Sand:Cement presets */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#8a6a0a' }}>% Sand</span>
                  <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5a7888', marginLeft: 3 }}>/ Cement</span>
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
              <div className="toolbar-divider" />
              {/* Force buttons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  className="action-btn replay-btn"
                  onClick={() => setManualForceN(n => Math.max(0, n - MANUAL_FORCE_STEP))}
                  disabled={manualForceN === 0 || manualInP2}
                >− 20 N</button>
                <div style={{
                  color: '#e4ddd0', fontSize: 18, fontWeight: 700, minWidth: 90,
                  textAlign: 'center', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em',
                  textShadow: '0 1px 3px rgba(0,0,0,0.6)',
                }}>
                  {manualForceN} N
                </div>
                <button
                  className="action-btn test-btn"
                  onClick={() => setManualForceN(n => Math.min(MANUAL_MAX_N, n + MANUAL_FORCE_STEP))}
                  disabled={manualInP2}
                >+ 20 N</button>
              </div>
              <div className="toolbar-divider" />
              {/* Show/Hide Visuals */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'rgba(200,215,230,0.45)' }}>Show/Hide Visuals</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <button className={`action-btn replay-btn${showCount ? ' active' : ''}`} onClick={() => setShowCount(f => !f)}>Count</button>
                  <button className={`action-btn replay-btn${chargeVisible ? ' active' : ''}`} onClick={() => setChargeVisible(f => !f)}>Charge</button>
                  <button className={`action-btn replay-btn${showField ? ' active' : ''}`} onClick={() => setShowField(f => !f)}>Field</button>
                </div>
              </div>
              <div className="toolbar-divider" />
              {/* Theme toggle */}
              <button
                className={`action-btn replay-btn${!darkMode ? ' active' : ''}`}
                onClick={() => setDarkMode(f => !f)}
                style={{ fontSize: 18, padding: '3px 9px 4px', lineHeight: 1, textShadow: darkMode ? '0 0 8px rgba(180,210,255,0.95), 0 0 18px rgba(120,170,255,0.6)' : '0 0 8px rgba(255,220,50,0.95), 0 0 18px rgba(255,160,0,0.65)' }}
              >{darkMode ? '☽' : '☀'}</button>
            </div>
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
              transform: 'scale(1.1)',
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
              pusherX={pusherX} pusherY={pusherY + pusherDropPct}
              pusherSize={pusherSize}
              lcdX={lcdX} lcdY={lcdY} lcdKN={lcdKN} containerW={308} lcdNudge={{ dx: 0, dy: 5 }}
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
              const atoms = [
                { particles: [{ x: 0, y: 0, r: 4,   type: 'Si' }],                 label: <><b>Si</b> <sup>δ+</sup></> },
                { particles: [{ x: 0, y: 0, r: 3,   type: 'O',  isGrain: true }],  label: <><b>O</b> <sup>δ−</sup></>  },
                { particles: [{ x: 0, y: 0, r: 5.5, type: 'Ca' }],                 label: <><b>Ca</b> <sup>2+</sup></>  },
                { particles: [{ x: 0, y: 0, r: 3,   type: 'O',  isGrain: false }], label: <><b>OH</b><sup>−</sup></>    },
              ]
              return (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', flexShrink: 0, padding: '0 6px', rowGap: 3 }}>
                  {atoms.map(({ particles }, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                      <BondIcon particles={particles} bonds={[]} scale={1.5} darkMode={darkMode} showCharge={chargeVisible} />
                    </div>
                  ))}
                  {atoms.map(({ label }, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: darkMode ? '#999' : '#666', fontFamily: 'system-ui,sans-serif' }}>{label}</span>
                    </div>
                  ))}
                </div>
              )
            })()}
            {/* Bond strain key */}
            {showField && (
              <svg viewBox="0 0 200 60" width="100%" style={{ display: 'block', flexShrink: 0 }}>
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
                <text x="0" y="16" style={{ fontSize: '16px', fill: darkMode ? '#999' : '#666', fontFamily: 'system-ui,sans-serif' }}>Energy in fields:</text>
                <rect x="0" y="20" width="200" height="12" fill="url(#cv-strain-grad)" rx="1" />
                <text x="0"   y="54" style={{ fontSize: '18px', fill: darkMode ? '#666' : '#888', fontFamily: 'system-ui,sans-serif' }}>Low</text>
                <text x="200" y="54" style={{ fontSize: '18px', fill: darkMode ? '#666' : '#888', fontFamily: 'system-ui,sans-serif', textAnchor: 'end' }}>High</text>
              </svg>
            )}
            {showCount && <div className="bond-analysis-box">
              {bondCounts && (() => {
                const tested = initialBondCounts !== null
                const rows = [
                  {
                    key: 'sand', label: 'Sand', color: '#c8961e',
                    getValue: c => c.siO,
                    icon: <BondIcon darkMode={darkMode} showCharge={chargeVisible} scale={1.0} particles={[
                      { x: 0, y: 0, r: 4, type: 'Si' },
                      { x: 16, y: 0, r: 3, type: 'O', isGrain: true },
                    ]} bonds={[{ i: 0, j: 1 }]} />,
                  },
                  {
                    key: 'sandCement', label: 'Sand-Cement', color: '#9c6828',
                    getValue: c => c.caO + c.siOH,
                    icon: <BondIcon darkMode={darkMode} showCharge={chargeVisible} scale={1.0} particles={[
                      { x: 0, y: 0,  r: 5.5, type: 'Ca' },
                      { x: 16, y: 0,  r: 3,   type: 'O', isGrain: true },
                      { x: 0, y: 14, r: 4,   type: 'Si' },
                      { x: 16, y: 14, r: 3,   type: 'O', isGrain: false },
                    ]} bonds={[{ i: 0, j: 1 }, { i: 2, j: 3 }]} />,
                  },
                  {
                    key: 'concrete', label: 'Cement', color: '#9a9292',
                    getValue: c => c.caOH,
                    icon: <BondIcon darkMode={darkMode} showCharge={chargeVisible} scale={1.0} particles={[
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
                    pct: tested && d.before > 0 ? (d.broken / d.before * 100).toFixed(1) : null,
                    bold: true,
                  }) },
                  { key: 'total', label: 'Total', getCell: d => ({
                    pct: tested && totalBroken > 0 ? (d.broken / totalBroken * 100).toFixed(1) : null,
                    bold: false,
                  }) },
                ]
                return (
                  <div style={{ padding: '6px 4px', display: 'flex', flexDirection: 'column', gap: 0, height: '100%', boxSizing: 'border-box' }}>
                    {/* Column headers — bond type icons + labels */}
                    <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 1fr 1fr', gap: '0', alignItems: 'end', marginBottom: 4 }}>
                      <span />
                      {colData.map(({ key, label, color, icon }) => (
                        <div key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                          {icon}
                          <span style={{ fontSize: 8, color, letterSpacing: '0.04em', lineHeight: 1, textAlign: 'center' }}>{label}</span>
                        </div>
                      ))}
                    </div>
                    {/* Value rows */}
                    {valueRows.map(({ key, label, getCell }) => (
                      <div key={key} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 1fr 1fr', gap: '0', alignItems: 'baseline', marginBottom: 3 }}>
                        <span style={{ fontSize: 8, letterSpacing: '0.07em', color: darkMode ? '#666' : '#888', textTransform: 'uppercase' }}>{label}</span>
                        {colData.map(d => {
                          const { val, pct, bold } = getCell(d)
                          return (
                            <div key={d.key} style={{ textAlign: 'center' }}>
                              {pct != null && (
                                <div style={{ fontSize: 12, color: d.color, opacity: 0.85, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, fontWeight: bold ? 700 : 500 }}>{pct}%</div>
                              )}
                              {pct == null && (
                                <span style={{ fontSize: 12, color: darkMode ? '#333' : '#bbb' }}>—</span>
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
        <div ref={microSquareRef} className="micro-square" style={{ border: '2px solid rgba(255,80,80,0.6)', display: photoView === 'off' && activeBox !== 'red' ? 'none' : undefined }}>
          <div style={simWrapperStyle}>
            <MicroPanelB
              sandPct={panelSandPct}
              phase={isManual ? (manualRecording ? 'failed' : 'idle') : (phase === 'failed' && !hasRecording ? 'testing' : phase)}
              layoutSeed={layoutSeed}
              force={panelForce} speed={speed} bondRound={bondRound} noDiag
              onSettled={isManual ? () => {} : handleSettled}
              onFailed={isManual ? () => {} : handleFailed}
              scrubT={isManual ? manualScrubT : (photoView === 'off' && hasRecording ? scrubT : null)}
              onRecordingReady={isManual ? () => {} : handleRecordingReady}
              p2DispScale={redP2DispScale}
              showField={isManual ? true : showField}
              showCharge={chargeVisible}
              darkMode={darkMode}
              preloadedRecording={isManual ? manualRecording : null}
              onBondCounts={setBondCounts}
            />
          </div>
        </div>

        {/* Blue view — big grain stops crack */}
        <div ref={blueSquareRef} className="micro-square" style={{ borderTop: '2px solid rgba(80,140,255,0.5)', display: photoView === 'off' && activeBox !== 'blue' ? 'none' : undefined }}>
          <div style={blueWrapperStyle}>
            <MicroPanelB
              sandPct={panelSandPct}
              phase={isManual ? 'idle' : bluePhase}
              layoutSeed={blueLayoutSeed}
              force={isManual ? 0 : panelForce} speed={speed} bondRound={bondRound} noDiag
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
        <div className="micro-square" style={{ borderTop: '2px solid rgba(10,10,10,0.9)', display: photoView === 'off' && activeBox === 'grey' ? undefined : 'none' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <MicroPanelB
              sandPct={panelSandPct} phase="idle" layoutSeed={greyLayoutSeed}
              force={0} speed={1} bondRound={bondRound} noDiag
              accentColor="#111111"
              onSettled={() => {}} onFailed={() => {}}
              scrubT={null}
              onRecordingReady={() => {}}
              showField={showField}
              showCharge={chargeVisible}
              darkMode={darkMode}
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
                  ? 'none'
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
                lcdX={lcdX} lcdY={lcdY} lcdKN={lcdKN} containerW={zoomLayerW}
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
            {photoView === 'full' && (
              <button
                className="action-btn test-btn"
                style={{ position: 'absolute', bottom: 14, right: 14, fontSize: 10, padding: '4px 12px', zIndex: 20 }}
                onClick={() => handleBoxClick('red')}
              >Zoom</button>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
