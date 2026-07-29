import { useState, useMemo, useEffect, useRef } from 'react'
import MacroPanel from './MacroPanel'
import MicroPanel, { MicroPanelB, buildGrains, buildCrackWaypoints, VW, VH } from './MicroPanel'
import './ConcreteViewer.css'

const SAND_PRESETS = [0, 20, 40, 60, 80]
const SPEEDS = [0.25, 0.5, 1.0, 2.0, 4.0]

export default function ConcreteViewer() {
  const [sandPct, setSandPct] = useState(40)
  const [phase, setPhase]     = useState('idle')  // 'idle'|'testing'|'settled'|'failed'
  const [force, setForce]     = useState(1000 / 1500)
  const [layoutSeed, setLayoutSeed] = useState(0)
  const [speedIdx, setSpeedIdx]     = useState(2)  // index into SPEEDS; default 1.0×

  const [view, setView]             = useState('B')

  const replayRef = useRef(false)

  // After a replay-triggered idle reset, auto-start the test
  useEffect(() => {
    if (phase === 'idle' && replayRef.current) {
      replayRef.current = false
      const id = requestAnimationFrame(() => setPhase('testing'))
      return () => cancelAnimationFrame(id)
    }
  }, [phase])

  // Compute grain layout + crack waypoints here so both panels share the same geometry
  const grains = useMemo(
    () => buildGrains(sandPct, layoutSeed * 7919 + sandPct * 137 + 42),
    [sandPct, layoutSeed]
  )
  const crackWaypoints = useMemo(() => buildCrackWaypoints(grains, sandPct), [grains, sandPct])

  // Normalised 0–1 waypoints for the macro block (scale to block coords in MacroPanel)
  const crackPts = useMemo(
    () => crackWaypoints.map(pt => [pt.x / VW, pt.y / VH]),
    [crackWaypoints]
  )

  function startTest() { setPhase('testing') }
  function reset()     { setPhase('idle') }
  function handleReplay() { replayRef.current = true; setPhase('idle') }

  function handleSandPct(pct) {
    setSandPct(pct)
    setPhase('idle')
    setLayoutSeed(s => s + 1)
  }

  function handleFailed()  { setPhase('failed') }
  function handleSettled() { setPhase('settled') }

  const speed = SPEEDS[speedIdx]

  return (
    <div className="viewer">
      <header className="top-bar">
        <div className="toolbar">
          <span className="toolbar-label">Sand %</span>
          {SAND_PRESETS.map(pct => (
            <button key={pct}
              className={`preset-btn ${sandPct === pct ? 'active' : ''}`}
              onClick={() => handleSandPct(pct)}
            >{pct}%</button>
          ))}
          <div className="toolbar-divider" />
          <button className="action-btn test-btn"
            onClick={startTest} disabled={phase === 'testing'}>
            Test
          </button>
          <button className="action-btn reset-btn"
            onClick={reset} disabled={phase === 'idle'}>
            Reset
          </button>
          <button className="action-btn replay-btn"
            onClick={handleReplay} disabled={phase === 'idle' || phase === 'testing'}>
            Replay
          </button>
          <div className="toolbar-divider" />
          <span className="toolbar-label speed-icon">🐢</span>
          <input
            type="range"
            className="speed-slider"
            min={0} max={4} step={1}
            value={speedIdx}
            onChange={e => setSpeedIdx(Number(e.target.value))}
          />
          <span className="toolbar-label speed-icon">🐇</span>
          <div className="toolbar-divider" />
          <button className={`preset-btn ${view === 'A' ? 'active' : ''}`} onClick={() => setView('A')}>View A</button>
          <button className={`preset-btn ${view === 'B' ? 'active' : ''}`} onClick={() => setView('B')}>View B</button>
        </div>
        <div className="macro-thumb">
          <span className="panel-title">Macro</span>
          <MacroPanel
            phase={phase}
            force={force}
            onForceChange={setForce}
            sandPct={sandPct}
            crackPts={crackPts}
            layoutSeed={layoutSeed}
          />
        </div>
        <div className="beam-photo">
          <img src={import.meta.env.BASE_URL + 'BeamTest.png'} alt="Beam test apparatus" />
        </div>
      </header>

      <main className="micro-section">
        <div className="force-viz-space">
          <span className="panel-title">Forces</span>
        </div>
        <div className="micro-square">
          <span className="panel-title">{view === 'A' ? 'View A' : 'View B'}</span>
          {view === 'A' ? (
            <MicroPanel
              sandPct={sandPct}
              phase={phase}
              layoutSeed={layoutSeed}
              force={force}
              speed={speed}
              crackWaypoints={crackWaypoints}
              onSettled={handleSettled}
              onFailed={handleFailed}
            />
          ) : (
            <MicroPanelB
              sandPct={sandPct}
              phase={phase}
              layoutSeed={layoutSeed}
              force={force}
              speed={speed}
              crackWaypoints={crackWaypoints}
              onSettled={handleSettled}
              onFailed={handleFailed}
            />
          )}
        </div>
      </main>
    </div>
  )
}
