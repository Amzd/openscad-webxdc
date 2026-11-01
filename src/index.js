import { mergeEditorText } from './merge.js'
import { createCodeSync } from './sync.js'
import { createViewer } from './viewer.js'

/**
 * @typedef {{
 *     id: string
 *     type: 'draft' | 'compiled'
 *     code: string
 *     cursor: number | null
 *     ts: number
 *     from: string
 *     name: string
 * }} SyncSnapshot
 */

/**
 * @typedef {{
 *     running: SyncSnapshot | null
 *     peers: Map<string, SyncSnapshot>
 * }} SyncState
 */

/**
 * @typedef {{ code: string; output: Uint8Array; logs: string[] }} RenderedModel
 */

/**
 * @typedef {{
 *     FS: {
 *         writeFile: (path: string, data: string | Uint8Array) => void
 *         unlink: (path: string) => void
 *         readFile: (path: string) => string | Uint8Array
 *     }
 *     callMain: (args: string[]) => number
 * }} WasmInstance
 */

const DEFAULT_CODE = `// A simple 20 mm cube
$fn = 48;
cube([20, 20, 20], center = true);
`

/** @param {string} id */
function requireElement(id) {
    const element = document.getElementById(id)
    if (!element) throw new Error(`Missing required element: #${id}`)
    return element
}

/** @param {string} text */
function captureOutput(text) {
    runtimeOutput.push(text)
}

function relevantRuntimeOutput() {
    // This headless build has no locale bundle; its startup warning is non-actionable.
    return runtimeOutput.filter(
        (line) => line && line !== 'Could not initialize localization.'
    )
}

const editor = /** @type {HTMLTextAreaElement} */ (requireElement('editor'))
const editorState = requireElement('editor-state')
const renderBtn = /** @type {HTMLButtonElement} */ (
    requireElement('render-btn')
)
const downloadBtn = /** @type {HTMLButtonElement} */ (
    requireElement('download-btn')
)
const statusText = requireElement('status-text')
const runningContent = requireElement('running-content')
const runningMeta = requireElement('running-meta')
const peersContent = requireElement('peers-content')
const tabsBar = requireElement('mobile-shared-tabs')
const sharedViews = requireElement('shared-views')
const sharedNotice = requireElement('shared-notice')
const workspace = requireElement('workspace')
const runningPanel = requireElement('running-panel')
const peersPanel = requireElement('peers-panel')

editor.value = DEFAULT_CODE

/** @type {SyncSnapshot | null} */
let latestRunning = null
/** @type {string} */
let baseCode = DEFAULT_CODE
/** @type {RenderedModel | null} */
let lastRender = null
/** @type {Promise<WasmInstance> | undefined} */
let wasmInstancePromise
/** @type {string[]} */
let runtimeOutput = []
let hasOutputFile = false
/** @type {string[]} */
let orderedPeerIds = []
/** @type {string | null} */
let selectedPeerFrom = null
/**
 * @type {Map<
 *     string,
 *     { card: HTMLElement; name: HTMLElement; body: HTMLElement }
 * >}
 */
const peerCards = new Map()
/** @type {Map<string, ReturnType<typeof createViewer>>} */
const viewers = new Map()

function updateEditorState() {
    if (!latestRunning) {
        editorState.textContent = 'Not rendered yet'
        editorState.classList.remove('draft')
        return
    }
    const differs = editor.value !== latestRunning.code
    editorState.textContent = differs
        ? 'Draft differs'
        : 'Matches latest render'
    editorState.classList.toggle('draft', differs)
}

/** @param {string} message @param {boolean} [isError] */
function setStatus(message, isError = false) {
    statusText.textContent = message
    statusText.classList.toggle('error', isError)
}

/** @param {string} text */
function emptyState(text) {
    const div = document.createElement('div')
    div.className = 'empty-state'
    div.textContent = text
    return div
}

/** @param {string} key @param {HTMLElement} container */
function getViewer(key, container) {
    let viewer = viewers.get(key)
    if (!viewer || !container.contains(viewer.dom)) {
        container.replaceChildren()
        viewer = createViewer()
        container.append(viewer.dom)
        viewers.set(key, viewer)
    }
    return viewer
}

/** @param {Blob} blob @param {string} filename */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function renderOutput() {
    if (!lastRender) {
        downloadBtn.disabled = true
        runningContent.replaceChildren(
            emptyState('Render your OpenSCAD code to create an STL model.')
        )
        return
    }

    downloadBtn.disabled = false
    const summary = document.createElement('div')
    summary.className = 'render-summary'
    const message = document.createElement('p')
    message.textContent = `STL ready (${(lastRender.output.byteLength / 1024).toFixed(1)} KB).`
    const source = document.createElement('pre')
    source.className = 'render-source'
    source.textContent = lastRender.code
    summary.append(message, source)
    if (lastRender.logs.length) {
        const logs = document.createElement('pre')
        logs.className = 'render-logs'
        logs.textContent = lastRender.logs.join('\n')
        summary.append(logs)
    }
    runningContent.replaceChildren(summary)
}

async function getWasmInstance() {
    if (!wasmInstancePromise) {
        const runtimeUrl = new URL('openscad/openscad.js', document.baseURI)
            .href
        wasmInstancePromise = import(/* @vite-ignore */ runtimeUrl)
            .then(({ default: OpenSCAD }) =>
                OpenSCAD({
                    noInitialRun: true,
                    print: captureOutput,
                    printErr: captureOutput,
                })
            )
            .catch((error) => {
                wasmInstancePromise = undefined
                throw error
            })
    }
    return wasmInstancePromise
}

async function renderCode() {
    if (renderBtn.disabled) return
    renderBtn.disabled = true
    setStatus('Loading OpenSCAD…')
    runtimeOutput = []

    try {
        const instance = await getWasmInstance()
        const code = editor.value
        instance.FS.writeFile('/input.scad', code)
        if (hasOutputFile) {
            instance.FS.unlink('/model.stl')
            hasOutputFile = false
        }

        setStatus('Rendering STL…')
        const exitCode = instance.callMain(['/input.scad', '-o', '/model.stl'])
        if (exitCode !== 0) {
            throw new Error(`OpenSCAD exited with code ${exitCode}`)
        }

        const output = instance.FS.readFile('/model.stl')
        if (!(output instanceof Uint8Array) || output.byteLength === 0) {
            throw new Error('OpenSCAD did not produce an STL file')
        }
        hasOutputFile = true
        lastRender = { code, output, logs: relevantRuntimeOutput() }
        renderOutput()
        codeSync.publish(code, editor.selectionStart)
        setStatus('Render complete')
        updateEditorState()
    } catch (error) {
        const diagnostics = relevantRuntimeOutput().slice(-3).join(' ')
        setStatus(
            (
                diagnostics ||
                (error instanceof Error ? error.message : String(error))
            )
                .replace(/^Error:\s*/i, '')
                .slice(0, 240),
            true
        )
        console.error('OpenSCAD render failed', error)
    } finally {
        renderBtn.disabled = false
    }
}

renderBtn.addEventListener('click', renderCode)
downloadBtn.addEventListener('click', () => {
    if (!lastRender) return
    downloadBlob(
        new Blob([lastRender.output], { type: 'application/octet-stream' }),
        'model.stl'
    )
})
editor.addEventListener('input', () => {
    updateEditorState()
    setStatus('Draft changed')
})

document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return
    if (event.key === 'Enter') {
        event.preventDefault()
        renderCode()
    } else if (event.key.toLowerCase() === 's' && !event.shiftKey) {
        event.preventDefault()
        renderCode()
    }
})

/** @param {string} addr */
function shortAddress(addr) {
    return addr.length > 12 ? `${addr.slice(0, 7)}…${addr.slice(-3)}` : addr
}

/** @param {number} peerCount */
function updatePeerLayout(peerCount) {
    const wideLayout = window.matchMedia(
        '(min-width: 560px) and (min-aspect-ratio: 6/5)'
    ).matches
    const availableColumns = Math.min(
        3,
        Math.floor((peersContent.clientWidth + 8) / 288)
    )
    const showGrid =
        wideLayout && peerCount > 0 && peerCount <= availableColumns
    peersContent.classList.toggle('peer-grid', showGrid)
    peersContent.classList.toggle('peer-tabs-mode', !showGrid)
    workspace.classList.toggle('peer-tabs-mode', !showGrid && peerCount > 0)
    sharedViews.classList.toggle('peer-tabs-mode', !showGrid && peerCount > 0)
    tabsBar.hidden = showGrid && peerCount > 0
    if (peerCount) {
        const cards = orderedPeerIds
            .map((id) => peerCards.get(id)?.card)
            .filter((card) => card !== undefined)
        const selectedCard =
            peerCards.get(selectedPeerFrom ?? '')?.card ??
            peerCards.get(orderedPeerIds[0] ?? '')?.card
        const visibleCards = showGrid
            ? cards
            : selectedCard
              ? [selectedCard]
              : []
        if (
            visibleCards.length !== peersContent.children.length ||
            visibleCards.some(
                (card, index) => peersContent.children[index] !== card
            )
        ) {
            peersContent.replaceChildren(...visibleCards)
        }
    }
}

new ResizeObserver(() => updatePeerLayout(peerCards.size)).observe(peersContent)
window.addEventListener('resize', () => updatePeerLayout(peerCards.size))

tabsBar.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const tab = event.target.closest('.tab')
    if (!(tab instanceof HTMLButtonElement)) return
    for (const item of tabsBar.querySelectorAll('.tab')) {
        item.classList.toggle('active', item === tab)
        item.setAttribute('aria-selected', item === tab ? 'true' : 'false')
    }
    const isRunning = tab.dataset.panel === 'running'
    runningPanel.classList.toggle('mobile-active', isRunning)
    peersPanel.classList.toggle('mobile-active', !isRunning)
    if (!isRunning && tab.dataset.peer) {
        selectedPeerFrom = tab.dataset.peer
        const entry = peerCards.get(tab.dataset.peer)
        if (entry) peersContent.replaceChildren(entry.card)
    }
})

/** @type {ReturnType<typeof setTimeout> | undefined} */
let noticeTimeout
function showSharedNotice() {
    sharedNotice.classList.add('show')
    clearTimeout(noticeTimeout)
    noticeTimeout = setTimeout(
        () => sharedNotice.classList.remove('show'),
        3000
    )
}

/** @param {SyncState} state */
function renderShared({ running, peers }) {
    latestRunning = running
    if (running) {
        runningMeta.textContent = lastRender
            ? 'by you'
            : running.from === window.webxdc.selfAddr
              ? 'by you'
              : `by ${running.name || shortAddress(running.from)}`
        renderOutput()
    } else {
        runningMeta.textContent = ''
        runningContent.replaceChildren(
            emptyState('Render your OpenSCAD code to create an STL model.')
        )
    }

    const others = [...peers.values()].filter(
        (peer) => peer.from !== window.webxdc.selfAddr
    )
    orderedPeerIds = others.map((peer) => peer.from)
    workspace.classList.toggle('has-peers', others.length > 0)
    selectedPeerFrom =
        [...others].sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))[0]
            ?.from ?? null
    tabsBar.replaceChildren()

    const runningTab = document.createElement('button')
    runningTab.className = 'tab active'
    runningTab.type = 'button'
    runningTab.setAttribute('role', 'tab')
    runningTab.dataset.panel = 'running'
    runningTab.textContent = 'Output'
    runningTab.setAttribute('aria-selected', 'true')
    tabsBar.append(runningTab)

    if (!others.length) {
        peerCards.clear()
        viewers.forEach((viewer, key) => {
            if (key.startsWith('peer:')) {
                viewer.destroy()
                viewers.delete(key)
            }
        })
        peersContent.replaceChildren(
            emptyState("Other participants' drafts will appear here.")
        )
    }

    for (const peer of others) {
        let entry = peerCards.get(peer.from)
        if (!entry) {
            const card = document.createElement('article')
            card.className = 'peer-card'
            const heading = document.createElement('div')
            heading.className = 'peer-heading'
            const name = document.createElement('strong')
            const body = document.createElement('div')
            heading.append(name)
            card.append(heading, body)
            entry = { card, name, body }
            peerCards.set(peer.from, entry)
        }
        entry.name.textContent = peer.name || shortAddress(peer.from)
        const peerTab = document.createElement('button')
        peerTab.className = 'tab'
        if (peer.from === selectedPeerFrom) peerTab.classList.add('active')
        peerTab.type = 'button'
        peerTab.setAttribute('role', 'tab')
        peerTab.dataset.panel = 'peer'
        peerTab.dataset.peer = peer.from
        peerTab.textContent = peer.name || shortAddress(peer.from)
        peerTab.setAttribute(
            'aria-selected',
            peer.from === selectedPeerFrom ? 'true' : 'false'
        )
        tabsBar.append(peerTab)
        getViewer(`peer:${peer.from}`, entry.body).update(
            peer.code,
            running?.code ?? null,
            peer.cursor
        )
    }

    if (others.length) {
        runningPanel.classList.add('mobile-active')
        peersPanel.classList.remove('mobile-active')
        updatePeerLayout(others.length)
    } else {
        orderedPeerIds = []
        selectedPeerFrom = null
        updatePeerLayout(0)
    }
    updateEditorState()
}

const codeSync = createCodeSync(onSharedChange)

/** @param {SyncState} state */
async function onSharedChange(state) {
    const { running } = state
    renderShared(state)
    if (!running || running.code === baseCode) return
    const previous = baseCode
    baseCode = running.code
    const local = editor.value
    const merged = mergeEditorText(previous, local, running.code)
    if (merged !== local) editor.value = merged
    if (merged !== local) showSharedNotice()
    updateEditorState()
}

function cursorPos() {
    return editor.selectionStart
}

/** @type {{ code: string; cursor: number } | null} */
let sentDraft = null
function shareDraft() {
    const draft = { code: editor.value, cursor: cursorPos() }
    if (sentDraft?.code === draft.code && sentDraft.cursor === draft.cursor)
        return
    sentDraft = draft
    codeSync.publishDraft(draft.code, draft.cursor)
}

renderShared(codeSync.state)
codeSync.ready.then(() => {
    const { running } = codeSync.state
    if (
        running &&
        editor.value === DEFAULT_CODE &&
        running.code !== editor.value
    ) {
        editor.value = running.code
        baseCode = running.code
    }
    updateEditorState()
    setInterval(shareDraft, 300)
})
