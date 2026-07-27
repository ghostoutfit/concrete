export default function App() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#1a1a1a',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif',
      color: '#e0d8d0',
      gap: 32,
    }}>
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: '0.04em' }}>
        Concrete Compression
      </h1>
      <div style={{ display: 'flex', gap: 24 }}>
        <a href="/concrete/v1/" style={cardStyle}>
          <span style={labelStyle}>v1</span>
          <span style={descStyle}>Original</span>
        </a>
        <a href="/concrete/v2/" style={cardStyle}>
          <span style={labelStyle}>v2</span>
          <span style={descStyle}>Spring-mass physics</span>
        </a>
        <a href="/concrete/v3/" style={cardStyle}>
          <span style={labelStyle}>v3</span>
          <span style={descStyle}>Fault-line physics</span>
        </a>
      </div>
    </div>
  )
}

const cardStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  padding: '32px 48px',
  background: '#2a2a2a',
  border: '1px solid #444',
  borderRadius: 12,
  textDecoration: 'none',
  color: 'inherit',
  cursor: 'pointer',
  transition: 'border-color 0.15s',
}

const labelStyle = { fontSize: 36, fontWeight: 700, color: '#d4813a' }
const descStyle  = { fontSize: 13, color: '#888' }
