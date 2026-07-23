import { useState, useEffect, useRef } from 'react'
import MacroPanel from './MacroPanel'
import MicroPanel from './MicroPanel'
import './ConcreteViewer.css'

const SAND_PRESETS = [0, 20, 40, 60, 80]
export const THRESHOLDS = { 0: 0.15, 20: 0.60, 40: 1.0, 60: 0.70, 80: 0.25 }
const RAMP_DURATION = 4000 // ms to go from 0 → 1.0

export default function ConcreteViewer() {
  const [sandPct, setSandPct] = useState(40)
  const [phase, setPhase] = useState('idle')   // 'idle' | 'testing' | 'failed'
  const [force, setForce] = useState(0)
  const [layoutSeed, setLayoutSeed] = useState(0)
  const [separationMode, setSeparationMode] = useState('shift')
  const rafRef = useRef(null)
  const startTimeRef = useRef(null)

  function startTest() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    startTimeRef.current = null
    setForce(0)
    setPhase('testing')
  }

  function reset() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPhase('idle')
    setForce(0)
  }

  function handleSandPct(pct) {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setSandPct(pct)
    setPhase('idle')
    setForce(0)
    setLayoutSeed(s => s + 1)
  }

  useEffect(() => {
    if (phase !== 'testing') return
    const threshold = THRESHOLDS[sandPct]

    function tick(now) {
      if (startTimeRef.current === null) startTimeRef.current = now
      const f = (now - startTimeRef.current) / RAMP_DURATION
      if (f >= threshold) {
        setForce(threshold)
        setPhase('failed')
        return
      }
      setForce(f)
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [phase, sandPct])

  return (
    <div className="viewer">
      <header className="top-bar">
        <div className="toolbar">
          <span className="toolbar-label">Sand %</span>
          {SAND_PRESETS.map(pct => (
            <button
              key={pct}
              className={`preset-btn ${sandPct === pct ? 'active' : ''}`}
              onClick={() => handleSandPct(pct)}
            >
              {pct}%
            </button>
          ))}
          <div className="toolbar-divider" />
          <button
            className="action-btn test-btn"
            onClick={startTest}
            disabled={phase === 'testing'}
          >
            Test
          </button>
          <button
            className="action-btn reset-btn"
            onClick={reset}
            disabled={phase === 'idle'}
          >
            Reset
          </button>
          <div className="toolbar-divider" />
          <span className="toolbar-label">sep</span>
          {['shift', 'squish'].map(m => (
            <button
              key={m}
              className={`preset-btn ${separationMode === m ? 'active' : ''}`}
              onClick={() => setSeparationMode(m)}
            >{m}</button>
          ))}
        </div>
        <div className="macro-thumb">
          <span className="panel-title">Macro</span>
          <MacroPanel phase={phase} force={force} sandPct={sandPct} layoutSeed={layoutSeed} />
        </div>
      </header>

      <main className="micro-section">
        <span className="panel-title">Micro</span>
        <MicroPanel sandPct={sandPct} phase={phase} layoutSeed={layoutSeed} separationMode={separationMode} />
      </main>
    </div>
  )
}
