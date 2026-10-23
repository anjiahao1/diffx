import type { FileDiffMetadata } from '@pierre/diffs'

export interface SearchHit {
  filePath: string
  side: 'additions' | 'deletions'
  lineNumber: number
  /** Display text of the line, without the trailing newline. */
  text: string
  /** 0-based index of the match within `text`. */
  start: number
  /** Length of the matched substring (in `text`, not the lowercased copy). */
  length: number
}

interface DisplayLine {
  side: 'additions' | 'deletions'
  lineNumber: number
  text: string
}

// Walk exactly the lines the diff renders: hunk context once (on the new-file
// side) and changed lines on their own side. Lines outside hunks are not
// displayed, so they are not searchable either.
function* displayedLines(file: FileDiffMetadata): Generator<DisplayLine> {
  for (const hunk of file.hunks) {
    for (const block of hunk.hunkContent) {
      if (block.type === 'context') {
        for (let i = 0; i < block.lines; i++) {
          const index = block.additionLineIndex + i
          yield {
            side: 'additions',
            lineNumber: hunk.additionStart + (index - hunk.additionLineIndex),
            text: stripNewline(file.additionLines[index] ?? ''),
          }
        }
        continue
      }
      for (let i = 0; i < block.deletions; i++) {
        const index = block.deletionLineIndex + i
        yield {
          side: 'deletions',
          lineNumber: hunk.deletionStart + (index - hunk.deletionLineIndex),
          text: stripNewline(file.deletionLines[index] ?? ''),
        }
      }
      for (let i = 0; i < block.additions; i++) {
        const index = block.additionLineIndex + i
        yield {
          side: 'additions',
          lineNumber: hunk.additionStart + (index - hunk.additionLineIndex),
          text: stripNewline(file.additionLines[index] ?? ''),
        }
      }
    }
  }
}

function stripNewline(line: string): string {
  return line.replace(/\r?\n$/, '')
}

export function searchDiff(files: FileDiffMetadata[], query: string, limit = 200): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const hits: SearchHit[] = []
  // ponytail: one hit per line (first match); report every occurrence if needed.
  for (const file of files) {
    for (const line of displayedLines(file)) {
      const start = line.text.toLowerCase().indexOf(needle)
      if (start === -1) continue
      hits.push({ filePath: file.name, ...line, start, length: needle.length })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

const FILE_TOP_GAP = 16
// ponytail: ~4s of virtualizer walking; a line beyond this stops at the file.
const MAX_FRAMES = 240

// Scroll to a hit's file, then walk the virtualized window until the line's
// gutter is rendered. The virtualizer only mounts rows near the viewport, so
// there is no DOM node to scrollIntoView until we get close.
export function revealSearchHit(hit: SearchHit): void {
  const scroller = document.querySelector<HTMLElement>('.main-scroll')
  let frames = 0
  let cooldown = 2
  let centerAttempts = 0

  const tick = () => {
    if (frames++ > MAX_FRAMES) return
    if (cooldown > 0) {
      cooldown--
      requestAnimationFrame(tick)
      return
    }

    const card = document.getElementById(`file-${hit.filePath}`)
    if (!card) return

    if (!scroller) {
      card.scrollIntoView({ block: 'start' })
      return
    }

    const cardTop = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    const cardBottom = cardTop + card.offsetHeight
    const viewport = scroller.clientHeight
    const minScroll = cardTop - FILE_TOP_GAP
    const maxScroll = Math.max(minScroll, cardBottom - viewport)

    // Bring the file into view first; the virtualizer renders a placeholder
    // until the card intersects its window.
    if (scroller.scrollTop < minScroll || scroller.scrollTop > maxScroll) {
      scroller.scrollTop = Math.max(minScroll, Math.min(maxScroll, scroller.scrollTop))
      cooldown = 2
      requestAnimationFrame(tick)
      return
    }

    const container = card.querySelector('diffs-container')
    const shadow = container?.shadowRoot
    if (!shadow) {
      // Viewed files render only a header; the caller un-views before
      // revealing, so wait for that re-render.
      cooldown = 2
      requestAnimationFrame(tick)
      return
    }

    const target = findGutter(shadow, hit.lineNumber, hit.side)
    if (target) {
      target.scrollIntoView({ block: 'center' })
      // The virtualizer may adjust scrollTop after re-measuring rows (scroll
      // anchoring), which can undo the centering. Re-center a few times until
      // the row is actually inside the viewport.
      if (isInsideScroller(target, scroller) || centerAttempts++ >= 3) return
      cooldown = 2
      requestAnimationFrame(tick)
      return
    }

    const gutters = Array.from(shadow.querySelectorAll<HTMLElement>('[data-column-number]'))
    if (gutters.length === 0) {
      cooldown = 2
      requestAnimationFrame(tick)
      return
    }

    // In split view the two sides can cover different line-number ranges, so
    // measure the range for the hit's own side. Fall back to all gutters when
    // the view has no side-specific rows (unified).
    const sideGutters = gutters.filter((gutter) => belongsToSide(gutter.dataset.lineType, hit.side))
    const measured = sideGutters.length > 0 ? sideGutters : gutters
    const numbers = measured.map((gutter) => Number(gutter.dataset.columnNumber)).filter(Number.isFinite)
    if (numbers.length === 0) {
      cooldown = 2
      requestAnimationFrame(tick)
      return
    }
    const min = Math.min(...numbers)
    const max = Math.max(...numbers)
    const rowHeight = measured[0].getBoundingClientRect().height || 20

    if (hit.lineNumber >= min && hit.lineNumber <= max) {
      // The range is rendered but this line has no row: it lives in collapsed
      // context. Stop with the file in view.
      return
    }

    const delta = (hit.lineNumber < min ? hit.lineNumber - min : hit.lineNumber - max) * rowHeight
    scroller.scrollTop = Math.max(minScroll, Math.min(maxScroll, scroller.scrollTop + delta))
    cooldown = 2
    requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)
}

function findGutter(shadow: ShadowRoot, lineNumber: number, side: SearchHit['side']): HTMLElement | null {
  const sideType = side === 'additions' ? 'change-addition' : 'change-deletion'
  return (
    shadow.querySelector<HTMLElement>(
      `[data-column-number="${lineNumber}"][data-line-type="${sideType}"], ` +
        `[data-column-number="${lineNumber}"][data-line-type="context"], ` +
        `[data-column-number="${lineNumber}"][data-line-type="change"]`,
    ) ?? shadow.querySelector<HTMLElement>(`[data-column-number="${lineNumber}"]`)
  )
}

function belongsToSide(lineType: string | undefined, side: SearchHit['side']): boolean {
  if (lineType === 'context' || lineType === 'change') return true
  return side === 'additions' ? lineType === 'change-addition' : lineType === 'change-deletion'
}

function isInsideScroller(element: HTMLElement, scroller: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  const view = scroller.getBoundingClientRect()
  return rect.top >= view.top && rect.bottom <= view.bottom
}
