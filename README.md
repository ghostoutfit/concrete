# Concrete Beam Test Simulator

## Sources

### Cement-to-Sand Strength Ratios

For structural grouting applications requiring high compressive strength, richer cement-sand mixes are necessary. "For structural grouting applications requiring high strength, richer mixes with ratios approaching 1:1 or 1:1.5 provide superior performance. These mixes contain higher cement content, resulting in increased compressive strength and reduced permeability" (Amix Systems, 2026)[1]. These mixes at 1:1 to 1:1.5 cement to sand are appropriate for foundation anchor grouting, rock bolt installation, structural void filling, and similar applications where load transfer is important.

At the other end of the scale, void-filling applications that require only modest strength use leaner formulations of 1:3 to 1:5 cement to sand (Amix Systems, 2026)[1]. These economical mixes reduce cement consumption significantly on high-volume projects such as abandoned mine void filling or pipeline bedding, while still achieving adequate compressive strength for ground stabilization.

by Glyn Lewis
May 16, 2026

## Simulation Strength Calibration

The simulator's LCD force readout is calibrated to the following baseline values, derived from the literature above. Each test draw is seeded from the sample layout, producing reproducible variability within the stated range.

| Sand % | Mean break strength | Variability |
|--------|--------------------:|------------:|
| 0%     | 600 kN              | ±40%        |
| 20%    | 650 kN              | ±20%        |
| 40%    | 750 kN              | ±10%        |
| 60%    | 1000 kN             | ±10%        |
| 80%    | 400 kN              | ±10%        |

These values are encoded in `SAND_BREAK_KN` and `SAND_BREAK_VAR` in `v4/src/ConcreteViewer.jsx`.

---

[1] Amix Systems. (2026). *Sand cement mix*. https://amixsystems.com/sand-cement-mix/
