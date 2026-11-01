# OpenSCAD

This [webxdc](https://webxdc.org/) runs [OpenSCAD](https://openscad.org/) in
WebAssembly and syncs OpenSCAD source code between chat participants. Render
your code to create and download an STL file. The app works offline after it
has been opened.

The WebAssembly runtime is bundled from
[openscad/openscad-wasm](https://github.com/openscad/openscad-wasm), release
[`2022.03.20`](https://github.com/openscad/openscad-wasm/releases/tag/2022.03.20).
The bundled WASM runtime is licensed under GPL-2.0; see `public/openscad/COPYING`.

The fastest way to use this is to send the app.xdc asset from releases into a
chat in [Delta Chat](https://delta.chat).

## Getting started

```sh
# Install dependencies
pnpm install
# Perform code checks
pnpm run check
# Start the webxdc emulator
pnpm run emulator
# Build the application for distribution
pnpm run build
```
