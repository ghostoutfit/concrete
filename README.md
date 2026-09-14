# Concrete Beam Test Simulator

## Sources

### Cement-to-Sand Strength Ratios

For structural grouting applications requiring high compressive strength, richer cement-sand mixes are necessary. "For structural grouting applications requiring high strength, richer mixes with ratios approaching 1:1 or 1:1.5 provide superior performance. These mixes contain higher cement content, resulting in increased compressive strength and reduced permeability" (Amix Systems, 2026)[1]. These mixes at 1:1 to 1:1.5 cement to sand are appropriate for foundation anchor grouting, rock bolt installation, structural void filling, and similar applications where load transfer is important.

At the other end of the scale, void-filling applications that require only modest strength use leaner formulations of 1:3 to 1:5 cement to sand (Amix Systems, 2026)[1]. These economical mixes reduce cement consumption significantly on high-volume projects such as abandoned mine void filling or pipeline bedding, while still achieving adequate compressive strength for ground stabilization.

by Glyn Lewis
May 16, 2026

## Simulation Strength Calibration

The simulator's LCD force readout is calibrated to the following baseline values, derived from the literature above.

| Sand % | Mean break strength | Variability |
|--------|--------------------:|------------:|
| 0%     | 600 kN              | ±40%        |
| 20%    | 650 kN              | ±20%        |
| 40%    | 750 kN              | ±10%        |
| 60%    | 900 kN              | ±10%        |
| 80%    | 400 kN              | ±10%        |

These values are encoded in `SAND_BREAK_KN` and `SAND_BREAK_VAR` in `v4/src/ConcreteViewer.jsx`.

### How the force display value is computed

Each test draw is seeded from the sample's grain layout (`layoutSeed`), which deterministically places grains and bonds. Different seeds produce different fault corridor geometries, and therefore different raw break forces — this is the source of natural variability between draws.

When a sample breaks, the raw internal force at that moment is captured. A z-score maps it into the target display range: the sample's position within the observed internal-force distribution (measured empirically across many seeds per ratio) is preserved, but the distribution is recentered at the target mean and rescaled to the target coefficient of variation. A draw that breaks early relative to its ratio's average will display toward the low end of the spec range; one that holds longer will display toward the high end. The bell-curve shape of the natural grain-layout variability is retained — only the mean and spread are adjusted to match the calibration table above.

During the loading animation (before break), the rising LCD readout uses a fixed linear scale per ratio so the display approaches a plausible value as force increases.

---

[1] Amix Systems. (2026). *Sand cement mix*. https://amixsystems.com/sand-cement-mix/
