import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { buildXDC, eruda, mockWebxdc } from '@webxdc/vite-plugins'
import { defineConfig } from 'vite'

/** @param {string} svgPath @param {string} pngName */
function svgToPng(svgPath, pngName) {
    return {
        name: 'svg-to-png',
        /** @param {{ dir?: string }} outputOptions */
        writeBundle(outputOptions) {
            try {
                const svg = readFileSync(svgPath)
                const resvg = new Resvg(svg, {
                    fitTo: { mode: 'width', value: 512 },
                })
                const png = resvg.render().asPng()
                const outputDir = resolve(outputOptions.dir ?? 'dist')
                mkdirSync(outputDir, { recursive: true })
                writeFileSync(resolve(outputDir, pngName), png)
            } catch (err) {
                throw new Error(
                    `svg-to-png: failed to convert "${svgPath}" to "${pngName}": ${err instanceof Error ? err.message : String(err)}`
                )
            }
        },
    }
}

export default defineConfig({
    plugins: [
        buildXDC(),
        eruda(),
        mockWebxdc(),
        svgToPng('src/icon.svg', 'icon.png'),
    ],
})
