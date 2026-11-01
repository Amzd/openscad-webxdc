// Line-based diff and three-way merge, adapted from the Code sync webxdc.

/**
 * @typedef {{ start: number; end: number; replacement: string[] }} Edit
 */

/**
 * @param {string[]} baseLines
 * @param {string[]} changedLines
 *
 * @returns {Edit[] | null}
 */
function lineEdits(baseLines, changedLines) {
    const rows = baseLines.length + 1
    const cols = changedLines.length + 1
    if (rows * cols > 1000000) return null

    const lcs = Array.from({ length: rows }, () => new Uint32Array(cols))
    /** @param {number} i @param {number} j */
    const at = (i, j) => lcs[i]?.[j] ?? 0
    for (let i = baseLines.length - 1; i >= 0; i--) {
        for (let j = changedLines.length - 1; j >= 0; j--) {
            const row = lcs[i]
            if (!row) continue
            row[j] =
                baseLines[i] === changedLines[j]
                    ? at(i + 1, j + 1) + 1
                    : Math.max(at(i + 1, j), at(i, j + 1))
        }
    }

    const edits = []
    let i = 0
    let j = 0
    while (i < baseLines.length || j < changedLines.length) {
        if (
            i < baseLines.length &&
            j < changedLines.length &&
            baseLines[i] === changedLines[j]
        ) {
            i++
            j++
            continue
        }

        const start = i
        const replacement = []
        while (i < baseLines.length || j < changedLines.length) {
            if (
                i < baseLines.length &&
                j < changedLines.length &&
                baseLines[i] === changedLines[j]
            )
                break
            if (
                i < baseLines.length &&
                (j === changedLines.length || at(i + 1, j) >= at(i, j + 1))
            ) {
                i++
            } else {
                replacement.push(changedLines[j] ?? '')
                j++
            }
        }
        edits.push({ start, end: i, replacement })
    }
    return edits
}

/**
 * @param {string} base
 * @param {string} changed
 */
export function changedLineIndexes(base, changed) {
    const baseLines = base.split('\n')
    const changedLines = changed.split('\n')
    const edits = lineEdits(baseLines, changedLines)
    const indexes = new Set()
    if (!edits) {
        for (let i = 0; i < changedLines.length; i++) indexes.add(i)
        return indexes
    }

    for (const edit of edits) {
        if (edit.replacement.length) {
            for (let i = 0; i < edit.replacement.length; i++) {
                indexes.add(Math.min(edit.start + i, changedLines.length - 1))
            }
        } else if (changedLines.length) {
            indexes.add(Math.min(edit.start, changedLines.length - 1))
        }
    }
    return indexes
}

/**
 * @param {string[]} left
 * @param {string[]} right
 *
 * @returns {string[]}
 */
function mergeAdditiveLines(left, right) {
    const rows = left.length + 1
    const cols = right.length + 1
    if (rows * cols > 1000000) {
        const result = []
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
            const leftLine = left[i]
            const rightLine = right[i]
            if (leftLine === rightLine) {
                if (leftLine !== undefined) result.push(leftLine)
            } else {
                if (leftLine !== undefined) result.push(leftLine)
                if (rightLine !== undefined) result.push(rightLine)
            }
        }
        return result
    }

    const lcs = Array.from({ length: rows }, () => new Uint32Array(cols))
    /** @param {number} i @param {number} j */
    const at = (i, j) => lcs[i]?.[j] ?? 0
    for (let i = left.length - 1; i >= 0; i--) {
        for (let j = right.length - 1; j >= 0; j--) {
            const row = lcs[i]
            if (!row) continue
            row[j] =
                left[i] === right[j]
                    ? at(i + 1, j + 1) + 1
                    : Math.max(at(i + 1, j), at(i, j + 1))
        }
    }

    const result = []
    let i = 0
    let j = 0
    while (i < left.length && j < right.length) {
        if (left[i] === right[j]) {
            result.push(left[i] ?? '')
            i++
            j++
        } else if (at(i + 1, j) >= at(i, j + 1)) {
            result.push(left[i++] ?? '')
        } else {
            result.push(right[j++] ?? '')
        }
    }
    result.push(...left.slice(i), ...right.slice(j))
    return result
}

/**
 * @param {string} base
 * @param {string} local
 * @param {string} incoming
 *
 * @returns {string}
 */
export function mergeEditorText(base, local, incoming) {
    if (local === base) return incoming
    if (incoming === base || local === incoming) return local

    const baseLines = base.split('\n')
    const localLines = local.split('\n')
    const incomingLines = incoming.split('\n')
    const localEdits = lineEdits(baseLines, localLines)
    const incomingEdits = lineEdits(baseLines, incomingLines)
    if (!localEdits || !incomingEdits) {
        return mergeAdditiveLines(localLines, incomingLines).join('\n')
    }

    /** @param {Edit} a @param {Edit} b */
    const conflicts = (a, b) => {
        const bothInsertAtSamePoint =
            a.start === a.end && b.start === b.end && a.start === b.start
        const rangesOverlap = a.start < b.end && b.start < a.end
        const insertionInsideA =
            b.start === b.end && b.start > a.start && b.start < a.end
        const insertionInsideB =
            a.start === a.end && a.start > b.start && a.start < b.end
        return (
            bothInsertAtSamePoint ||
            rangesOverlap ||
            insertionInsideA ||
            insertionInsideB
        )
    }

    /** @type {{ edit: Edit; side: 'local' | 'incoming' }[]} */
    const entries = [
        ...localEdits.map((edit) => ({
            edit,
            side: /** @type {'local'} */ ('local'),
        })),
        ...incomingEdits.map((edit) => ({
            edit,
            side: /** @type {'incoming'} */ ('incoming'),
        })),
    ]
    const parents = entries.map((_, index) => index)
    /** @param {number} index */
    const find = (index) => {
        while (parents[index] !== undefined && parents[index] !== index) {
            const parent = parents[index]
            if (parent === undefined) break
            parents[index] = parents[parent] ?? parent
            index = parents[index] ?? parent
        }
        return index
    }
    /** @param {number} a @param {number} b */
    const unite = (a, b) => {
        const rootA = find(a)
        const rootB = find(b)
        if (rootA !== rootB) parents[rootB] = rootA
    }

    for (let i = 0; i < localEdits.length; i++) {
        for (let j = 0; j < incomingEdits.length; j++) {
            const localEdit = localEdits[i]
            const incomingEdit = incomingEdits[j]
            if (localEdit && incomingEdit && conflicts(localEdit, incomingEdit))
                unite(i, localEdits.length + j)
        }
    }

    /** @type {Map<number, { edit: Edit; side: 'local' | 'incoming' }[]>} */
    const groups = new Map()
    entries.forEach((entry, index) => {
        const root = find(index)
        if (!groups.has(root)) groups.set(root, [])
        groups.get(root)?.push(entry)
    })

    /** @param {Edit[]} edits @param {number} start @param {number} end */
    const applyGroup = (edits, start, end) => {
        const result = []
        let cursor = start
        for (const edit of edits.sort(
            (a, b) => a.start - b.start || a.end - b.end
        )) {
            result.push(
                ...baseLines.slice(cursor, edit.start),
                ...edit.replacement
            )
            cursor = edit.end
        }
        result.push(...baseLines.slice(cursor, end))
        return result
    }

    /** @type {Edit[]} */
    const edits = []
    for (const group of groups.values()) {
        const localGroup = group
            .filter((entry) => entry.side === 'local')
            .map((entry) => entry.edit)
        const incomingGroup = group
            .filter((entry) => entry.side === 'incoming')
            .map((entry) => entry.edit)
        if (!localGroup.length || !incomingGroup.length) {
            edits.push(...group.map((entry) => entry.edit))
            continue
        }

        const groupEdits = [...localGroup, ...incomingGroup]
        const start = Math.min(...groupEdits.map((edit) => edit.start))
        const end = Math.max(...groupEdits.map((edit) => edit.end))
        const localResult = applyGroup(localGroup, start, end)
        const incomingResult = applyGroup(incomingGroup, start, end)
        edits.push({
            start,
            end,
            replacement: mergeAdditiveLines(localResult, incomingResult),
        })
    }

    edits.sort((a, b) => a.start - b.start || a.end - b.end)
    const result = []
    let cursor = 0
    for (const edit of edits) {
        result.push(...baseLines.slice(cursor, edit.start), ...edit.replacement)
        cursor = edit.end
    }
    result.push(...baseLines.slice(cursor))
    return result.join('\n')
}
