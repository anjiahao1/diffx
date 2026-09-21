import { useState, useRef, memo } from 'react'
import { FileDiff } from '@pierre/diffs/react'
import type { DiffLineAnnotation, FileDiffMetadata, AnnotationSide } from '@pierre/diffs'
import type { ReviewComment } from '../../types'
import { CommentForm } from './CommentForm'
import { CommentBubble } from './CommentBubble'

interface PendingComment {
  side: AnnotationSide
  lineNumber: number
  columnStart?: number
  columnEnd?: number
}

// Column anchor: when the reviewer selected a stretch of text before clicking
// +, locate it inside this line's content (0-based character offsets).
function captureColumn(lineContent: string): { columnStart: number; columnEnd: number } | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return null
  const text = sel.toString().trim()
  if (!text) return null
  // Multi-line or whitespace-variant selections don't match the raw line
  // content; fall back to a plain line comment.
  const exact = lineContent.indexOf(text)
  if (exact !== -1) return { columnStart: exact, columnEnd: exact + text.length }
  const compact = lineContent.replace(/\s+/g, ' ')
  const idx = compact.indexOf(text.replace(/\s+/g, ' ').trim())
  if (idx !== -1) return { columnStart: idx, columnEnd: idx + text.length }
  return null
}

interface FileDiffCardProps {
  id?: string
  fileDiff: FileDiffMetadata
  filePath: string
  annotations: DiffLineAnnotation<ReviewComment>[]
  diffStyle: 'split' | 'unified'
  tabSize: number
  softWrap: boolean
  viewed: boolean
  onViewedChange: (filePath: string, viewed: boolean) => void
  onAddComment: (filePath: string, side: AnnotationSide, lineNumber: number, lineContent: string, body: string, column?: { columnStart: number; columnEnd: number }) => void
  onDeleteComment: (id: string) => void
  onResolveComment: (id: string) => void
  onReply?: (commentId: string, body: string) => void
}

export const FileDiffCard = memo(function FileDiffCard({
  id,
  fileDiff,
  filePath,
  annotations,
  diffStyle,
  tabSize,
  softWrap,
  viewed,
  onViewedChange,
  onAddComment,
  onDeleteComment,
  onResolveComment,
  onReply,
}: FileDiffCardProps) {
  const [pending, setPending] = useState<PendingComment | null>(null)

  const getLineContent = (side: AnnotationSide, lineNumber: number): string => {
    const lines = side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines
    // Full (non-partial) diffs carry the entire file, so any line — including
    // expanded context outside hunks — can be addressed directly.
    if (!fileDiff.isPartial) {
      return lines[lineNumber - 1] ?? ''
    }
    const startKey = side === 'additions' ? 'additionStart' : 'deletionStart'
    const countKey = side === 'additions' ? 'additionCount' : 'deletionCount'
    const indexKey = side === 'additions' ? 'additionLineIndex' : 'deletionLineIndex'
    for (const hunk of fileDiff.hunks) {
      const start = hunk[startKey]
      const count = hunk[countKey]
      if (lineNumber >= start && lineNumber < start + count) {
        const index = hunk[indexKey] + (lineNumber - start)
        return lines[index] ?? ''
      }
    }
    return ''
  }

  const allAnnotations: DiffLineAnnotation<ReviewComment | { _pending: true }>[] = [
    ...annotations,
    ...(pending
      ? [
          {
            side: pending.side,
            lineNumber: pending.lineNumber,
            metadata: { _pending: true as const },
          },
        ]
      : []),
  ]

  return (
    <div className={`file-diff-card ${viewed ? 'file-diff-viewed' : ''}`} id={id}>
      {viewed ? (
        <div className="file-diff-viewed-header">
          <span className="file-diff-viewed-name">{filePath}</span>
          <label className="viewed-label viewed-checked" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={viewed}
              onChange={(e) => onViewedChange(filePath, e.target.checked)}
            />
            Viewed
          </label>
        </div>
      ) : (
        <>
          <FileDiff<ReviewComment | { _pending: true }>
            fileDiff={fileDiff}
            options={{
              diffStyle,
              stickyHeader: true,
              expansionLineCount: 20,
              enableGutterUtility: true,
              theme: { dark: 'github-dark', light: 'github-light' },
              themeType: 'system',
              overflow: softWrap ? 'wrap' : 'scroll',
              unsafeCSS: `:host { --diffs-tab-size: ${tabSize}; }`,
            }}
            lineAnnotations={allAnnotations}
            renderHeaderMetadata={() => (
              <label className="viewed-label" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={viewed}
                  onChange={(e) => onViewedChange(filePath, e.target.checked)}
                />
                Viewed
              </label>
            )}
            renderAnnotation={(annotation) => {
              if ('_pending' in annotation.metadata) {
                return (
                  <CommentForm
                    quote={
                      typeof pending!.columnStart === 'number' && typeof pending!.columnEnd === 'number'
                        ? getLineContent(pending!.side, pending!.lineNumber).slice(pending!.columnStart, pending!.columnEnd)
                        : undefined
                    }
                    onSubmit={(body) => {
                      const lineContent = getLineContent(pending!.side, pending!.lineNumber)
                      onAddComment(
                        filePath,
                        pending!.side,
                        pending!.lineNumber,
                        lineContent,
                        body,
                        typeof pending!.columnStart === 'number' && typeof pending!.columnEnd === 'number'
                          ? { columnStart: pending!.columnStart, columnEnd: pending!.columnEnd }
                          : undefined,
                      )
                      setPending(null)
                    }}
                    onCancel={() => setPending(null)}
                  />
                )
              }
              return (
                <CommentBubble
                  comment={annotation.metadata as ReviewComment}
                  onDelete={onDeleteComment}
                  onResolve={onResolveComment}
                  onReply={onReply}
                />
              )
            }}
            renderGutterUtility={(getHoveredLine) => (
              <button
                className="gutter-add-btn"
                onClick={() => {
                  const line = getHoveredLine()
                  if (line) {
                    // Capture the reviewer's text selection as a column
                    // anchor when it matches this line's content.
                    const column = captureColumn(getLineContent(line.side, line.lineNumber))
                    if (column) {
                      setPending({ side: line.side, lineNumber: line.lineNumber, columnStart: column.columnStart, columnEnd: column.columnEnd })
                    } else {
                      setPending({ side: line.side, lineNumber: line.lineNumber })
                    }
                  }
                }}
              >
                +
              </button>
            )}
          />
        </>
      )}
    </div>
  )
})
