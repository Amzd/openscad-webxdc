import { changedLineIndexes } from './merge.js'

/**
 * @returns {{
 *     dom: HTMLPreElement
 *     update: (
 *         code: string,
 *         compareCode?: string | null,
 *         cursor?: number | null
 *     ) => void
 *     destroy: () => void
 * }}
 */
export function createViewer() {
    const dom = document.createElement('pre')
    dom.className = 'viewer'

    return {
        dom,
        /**
         * @param {string} code @param {string | null} [compareCode] @param
         *   {number | null} [cursor]
         */
        update(code, compareCode = null, cursor = null) {
            const changed =
                typeof compareCode === 'string'
                    ? changedLineIndexes(compareCode, code)
                    : new Set()
            const lines = code.split('\n')
            const cursorLine =
                cursor === null
                    ? -1
                    : code.slice(0, Math.min(cursor, code.length)).split('\n')
                          .length - 1
            const cursorColumn =
                cursor === null
                    ? -1
                    : (code
                          .slice(0, Math.min(cursor, code.length))
                          .split('\n')
                          .at(-1)?.length ?? 0)
            dom.replaceChildren()

            lines.forEach((text, index) => {
                const line = document.createElement('span')
                line.className = changed.has(index)
                    ? 'viewer-line changed'
                    : 'viewer-line'
                if (index === cursorLine) {
                    line.append(
                        document.createTextNode(text.slice(0, cursorColumn))
                    )
                    const marker = document.createElement('span')
                    marker.className = 'viewer-cursor'
                    marker.setAttribute('aria-hidden', 'true')
                    line.append(
                        marker,
                        document.createTextNode(text.slice(cursorColumn))
                    )
                } else {
                    line.textContent = text
                }
                dom.append(line, document.createTextNode('\n'))
            })
        },
        destroy() {
            dom.remove()
        },
    }
}
