import { useState } from 'react'
import MacroPanel from './MacroPanel'
import MicroPanel from './MicroPanel'
import './ConcreteViewer.css'

const SAND_PRESETS = [0, 20, 40, 60, 80]
const SCOPE_OPTIONS = [
  { value: 'everything',  label: 'Everything' },
  { value: 'stress-cone', label: 'Stress cone' },
  { value: 'top-half',    label: 'Top half' },
  { value: 'circular',    label: 'Circular zone' },
]

// Force fraction (0–1) at which each mix cracks.
// Mirrors v1's strength curve: 40% sand is optimal, 0% and 80% are brittle.
// Scaled to ~65% of slider for the strongest mix so users can explore both sides.
export const CRACK_THRESHOLD = { 0: 0.10, 20: 0.40, 40: 0.65, 60: 0.50, 80: 0.20 }

export default function ConcreteViewer() {
  const [sandPct, setSandPct] = useState(40)
  const [phase, setPhase]     = useState('idle')  // 'idle'|'testing'|'settled'|'failed'
  const [force, setForce]     = useState(0)
  const [layoutSeed, setLayoutSeed] = useState(0)
  const [calcScope, setCalcScope]   = useState('everything')

  function startTest() { setPhase('testing') }

  function reset() { setPhase('idle') }

  function handleSandPct(pct) {
    setSandPct(pct)
    setPhase('idle')
    setLayoutSeed(s => s + 1)
  }

  function handleSettled() {
    setPhase(force > CRACK_THRESHOLD[sandPct] ? 'failed' : 'settled')
  }

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
            layoutSeed={layoutSeed}
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
          onSettled={handleSettled}
        />
      </main>
    </div>
  )
}
