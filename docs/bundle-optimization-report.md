# Bundle Optimization Report

**Review date:** 2026-11-23

## Baseline

The pre-change production build contained a 506.54 KB emoji chunk and a
1,315.35 KB face-detection chunk. The face package was already dynamically imported,
but emoji usage was not lazy in every surface and feature chunk naming was less clear.

## Final build

| Asset | Size | Gzip | Loading behavior |
| --- | ---: | ---: | --- |
| Core entry chunk | 211.99 KB | 58.77 KB | Initial route |
| Emoji chunk | 512.10 KB | 112.27 KB | Lazy on emoji picker use |
| Face detection chunk | 1,315.35 KB | 329.70 KB | Lazy when identity verification runs |
| Radix UI chunk | 140.99 KB | 46.32 KB | Independent shared UI chunk |
| Supabase client chunk | 214.24 KB | 55.10 KB | Independent auth/data chunk |

## Implemented changes

- Added a dedicated `emoji` Vite/Rollup manual chunk.
- Added lazy loading for the emoji picker on feed reactions.
- Kept the existing lazy emoji picker for chat message composition.
- Kept `@vladmandic/face-api` in a dedicated dynamic face chunk.
- Added route-level lazy loading for settings and signed-in surfaces.
- Replaced mixed utility/component exports that interfered with Fast Refresh.

## Verification

The final production build completed successfully. No core route warning remains
from emoji or face assets; the standalone face package remains above 1 MB because
it contains the browser face detector and model runtime. Both feature groups are
isolated and not fetched until their user path is activated.
