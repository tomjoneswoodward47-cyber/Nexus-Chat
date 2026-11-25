# Nexus Chat Brand Asset Exports

Generated from `assets/brand/logo-master.png` with `node scripts/export-brand-assets.mjs`.
The logo master is a transparent 761 x 927 px RGBA PNG. The emblem-only icon is
cropped from the chart and chat-bubble artwork, excluding the wordmark for legibility
at small sizes.

## Asset map

- `web/`: transparent full logo in PNG, WebP, and SVG, plus white- and navy-backed PNGs.
- `icons/`: app icon, maskable icon, light-background icon, transparent emblem, and
  16/32/48/64/128/256 px favicons with a multi-resolution `favicon.ico`.
- `android/res/`: density-specific launcher icons, adaptive icon XML, and background
  color resource.
- `ios/AppIcon.appiconset/`: Xcode app icon PNG sizes and `Contents.json`.
- `desktop/`: multi-resolution Windows `.ico` and macOS `.icns`.
- `print/`: 300-DPI PNG and a Letter-size PDF with the mark placed at its native
  300-DPI size.

## Background and accessibility

Use `nexus-chat-logo.png` over either background when its transparency provides
sufficient contrast. Prefer `nexus-chat-logo-light.png` on light surfaces and
`nexus-chat-logo-dark.png` on dark surfaces. App icons are opaque navy tiles;
`nexus-chat-app-icon-light-512.png` is available for light contexts.

For an informative logo, give the image alternative text such as `Nexus Chat`.
For an adjacent wordmark or when the logo is decorative, use empty alternative text
(`alt=""`) to avoid repeating the brand name. Keep the full wordmark at a size where
the lettering remains readable; use the emblem-only mark for compact placements.

The source art contains detailed raster effects, so the SVG is a standards-compatible
wrapper around the original PNG, not editable vector paths. The PDF also embeds a
raster image. The print export is 761 x 927 pixels at 300 DPI (about 2.54 inches wide);
larger print placements need a higher-resolution or true-vector master to avoid
visible resampling.

## Rebuild

Run `node scripts/export-brand-assets.mjs` from the repository root. It recreates
this export directory from the current brand master using the existing `sharp`
dependency.
