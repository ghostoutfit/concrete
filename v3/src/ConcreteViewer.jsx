import { useState, useMemo } from 'react'
import MacroPanel from './MacroPanel'
import MicroPanel, { buildGrains, buildCrackWaypoints, VW, VH } from './MicroPanel'
import './ConcreteViewer.css'

const SAND_PRESETS = [0, 20, 40, 60, 80]
const SCOPE_OPTIONS = [
  { value: 'crack-zone',  label: '10 atoms from crack' },
  { value: 'everything',  label: 'Everything' },
  { value: 'stress-cone', label: 'Stress cone' },
  { value: 'top-half',    label: 'Top half' },
]

export default function ConcreteViewer() {
  const [sandPct, setSandPct] = useState(40)
  const [phase, setPhase]     = useState('idle')  // 'idle'|'testing'|'settled'|'failed'
  const [force, setForce]     = useState(0)
  const [layoutSeed, setLayoutSeed] = useState(0)
  const [calcScope, setCalcScope]   = useState('crack-zone')

  // Compute grain layout + crack waypoints here so both panels share the same geometry
  const grains = useMemo(
    () => buildGrains(sandPct, layoutSeed * 7919 + sandPct * 137 + 42),
    [sandPct, layoutSeed]
  )
  const crackWaypoints = useMemo(() => buildCrackWaypoints(grains), [grains])

  // Normalised 0–1 waypoints for the macro block (scale to block coords in MacroPanel)
  const crackPts = useMemo(
    () => crackWaypoints.map(pt => [pt.x / VW, pt.y / VH]),
    [crackWaypoints]
  )

  function startTest() { setPhase('testing') }
  function reset()     { setPhase('idle') }

  function handleSandPct(pct) {
    setSandPct(pct)
    setPhase('idle')
    setLayoutSeed(s => s + 1)
  }

  // Physics tells us the outcome — no hardcoded thresholds
  function handleFailed()  { setPhase('failed') }
  function handleSettled() { setPhase('settled') }

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
          <div className="toolbar-divider" />
          <span className="toolbar-label">Scope</span>
          <select className="scope-select" value={calcScope}
            onChange={e => setCalcScope(e.target.value)}>
            {SCOPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="macro-thumb">
          <span className="panel-title">Macro</span>
          <MacroPanel
            phase={phase}
            force={force}
            onForceChange={setForce}
            sandPct={sandPct}
            crackPts={crackPts}
          />
        </div>
      </header>

      <main className="micro-section">
        <span className="panel-title">Micro</span>
        <MicroPanel
          sandPct={sandPct}
          phase={phase}
          layoutSeed={layoutSeed}
          force={force}
          calcScope={calcScope}
          crackWaypoints={crackWaypoints}
          onSettled={handleSettled}
          onFailed={handleFailed}
        />
      </main>
    </div>
  )
}
