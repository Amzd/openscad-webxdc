import { mergeEditorText } from './merge.js'
import { createModelViewer } from './model-viewer.js'
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
 *     documentName: string
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
const documentNameInput = /** @type {HTMLInputElement} */ (
    requireElement('document-name')
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
/** @type {ReturnType<typeof createModelViewer> | undefined} */
let modelViewer

editor.value = DEFAULT_CODE

/** @type {SyncSnapshot | null} */
let latestRunning = null
/** @type {string} */
let baseCode = DEFAULT_CODE
/** @type {RenderedModel | null} */
let lastRender = null
/** @type {string[]} */
let runtimeOutput = []
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

/** @param {Uint8Array} bytes */
function toBase64(bytes) {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
}

function renderOutput() {
    if (!lastRender) {
        modelViewer?.destroy()
        modelViewer = undefined
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
    message.textContent = 'Render complete'
    const preview = document.createElement('div')
    preview.className = 'model-preview-container'
    summary.append(message, preview)

    if (!modelViewer) {
        try {
            modelViewer = createModelViewer()
        } catch (error) {
            console.error('Unable to initialize 3D preview', error)
            const unavailable = document.createElement('p')
            unavailable.className = 'preview-error'
            unavailable.textContent =
                '3D preview is unavailable in this environment. You can still export the STL.'
            summary.append(unavailable)
        }
    }
    if (modelViewer) {
        preview.append(modelViewer.dom)
        try {
            modelViewer.update(lastRender.output)
        } catch (error) {
            console.error('Unable to display rendered STL', error)
            modelViewer.destroy()
            modelViewer = undefined
            const unavailable = document.createElement('p')
            unavailable.className = 'preview-error'
            unavailable.textContent =
                'Unable to display this STL. You can still export the file.'
            preview.replaceWith(unavailable)
        }
    }

    const source = document.createElement('details')
    source.className = 'render-details'
    const sourceSummary = document.createElement('summary')
    sourceSummary.textContent = 'OpenSCAD source'
    const sourceCode = document.createElement('pre')
    sourceCode.className = 'render-source'
    sourceCode.textContent = lastRender.code
    source.append(sourceSummary, sourceCode)
    summary.append(source)
    if (lastRender.logs.length) {
        const logsDetails = document.createElement('details')
        logsDetails.className = 'render-details'
        const logsSummary = document.createElement('summary')
        logsSummary.textContent = 'Render logs'
        const logs = document.createElement('pre')
        logs.className = 'render-logs'
        logs.textContent = lastRender.logs.join('\n')
        logsDetails.append(logsSummary, logs)
        summary.append(logsDetails)
    }
    runningContent.replaceChildren(summary)
}

// The Emscripten runtime keeps state in globals (e.g. calledRun), so a second
// load in the same window never initializes. Each render gets its own iframe.
async function getWasmInstance() {
    const frame = document.createElement('iframe')
    frame.hidden = true
    const loaded = new Promise((resolve, reject) => {
        frame.addEventListener('load', resolve, { once: true })
        frame.addEventListener(
            'error',
            () => reject(new Error('Failed to load OpenSCAD runtime.')),
            { once: true }
        )
    })
    frame.src = new URL('openscad/frame.html', document.baseURI).href
    document.body.append(frame)
    try {
        await loaded
        const create = frame.contentWindow?.createOpenSCAD
        if (!create) throw new Error('Failed to load OpenSCAD runtime.')
        const instance = await create({
            noInitialRun: true,
            print: captureOutput,
            printErr: captureOutput,
        })
        return { instance, dispose: () => frame.remove() }
    } catch (error) {
        frame.remove()
        throw error
    }
}

async function renderCode() {
    if (renderBtn.disabled) return
    renderBtn.disabled = true
    setStatus('Loading OpenSCAD…')
    runtimeOutput = []

    let runtime
    try {
        runtime = await getWasmInstance()
        const { instance } = runtime
        const code = editor.value
        instance.FS.writeFile('/input.scad', code)

        setStatus('Rendering STL…')
        const exitCode = instance.callMain(['/input.scad', '-o', '/model.stl'])
        if (exitCode !== 0) {
            throw new Error(`OpenSCAD exited with code ${exitCode}`)
        }

        const rendered = instance.FS.readFile('/model.stl')
        const output = new Uint8Array(rendered)
        if (output.byteLength === 0) {
            throw new Error('OpenSCAD did not produce an STL file')
        }
        lastRender = { code, output, logs: relevantRuntimeOutput() }
        renderOutput()
        codeSync.publish(code, editor.selectionStart)
        setStatus('')
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
        runtime?.dispose()
        renderBtn.disabled = false
    }
}

renderBtn.addEventListener('click', renderCode)
downloadBtn.addEventListener('click', async () => {
    if (!lastRender) return
    try {
        await window.webxdc.sendToChat({
            file: {
                name: 'model.stl',
                base64: toBase64(new Uint8Array(lastRender.output)),
            },
        })
    } catch (error) {
        console.error('Unable to export STL', error)
        setStatus('Export failed')
    }
})
documentNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault()
        documentNameInput.blur()
    }
})
documentNameInput.addEventListener('change', () => {
    const name = documentNameInput.value.trim().slice(0, 100)
    if (!name) {
        documentNameInput.value = codeSync.state.documentName
        return
    }
    documentNameInput.value = name
    codeSync.setDocumentName(name)
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
        modelViewer?.destroy()
        modelViewer = undefined
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
    if (documentNameInput !== document.activeElement) {
        documentNameInput.value = state.documentName
    }
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
