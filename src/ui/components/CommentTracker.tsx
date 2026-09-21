import { useState } from 'react'
import {
  MessageSquare,
  CheckCircle2,
  Reply,
  Circle,
  GitCompare,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import type { ReviewComment } from '../../types'
import { timeAgo, truncate, fileName, COMMIT_MESSAGE } from '../utils'

interface CommentTrackerProps {
  comments: ReviewComment[]
  // Navigate the main view to where this comment sits (switching to its
  // commit view first when it's anchored to a different one).
  onJumpToComment: (comment: ReviewComment) => void
}

type CommentStatus = 'open' | 'replied' | 'resolved'

function getCommentStatus(comment: ReviewComment): CommentStatus {
  if (comment.status === 'resolved') return 'resolved'
  if (comment.replies?.length > 0) return 'replied'
  return 'open'
}

function StatusBadge({ status }: { status: CommentStatus }) {
  switch (status) {
    case 'open':
      return (
        <span className="ct-status ct-status-open" title="Open">
          <Circle size={12} />
        </span>
      )
    case 'replied':
      return (
        <span className="ct-status ct-status-replied" title="Replied">
          <Reply size={12} />
        </span>
      )
    case 'resolved':
      return (
        <span className="ct-status ct-status-resolved" title="Resolved">
          <CheckCircle2 size={12} />
        </span>
      )
  }
}

// Commit-anchored comments can show what changed in that file since the
// comment was made: a blob-to-blob diff between the snapshot oid and now.
async function fetchPatchsetDiff(comment: ReviewComment): Promise<string | null> {
  const repo = comment.repo ?? ''
  const path =
    repo && comment.filePath.startsWith(repo + '/')
      ? comment.filePath.slice(repo.length + 1)
      : comment.filePath
  const params = new URLSearchParams({ repo, commit: comment.commitSha!, path })
  try {
    const res = await fetch(`/api/patchset-diff?${params}`)
    if (!res.ok) return null
    const data = await res.json()
    return typeof data.patch === 'string' ? data.patch : null
  } catch {
    return null
  }
}

export function CommentTracker({ comments, onJumpToComment }: CommentTrackerProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [diffView, setDiffView] = useState<{ title: string; patch: string } | null>(null)

  if (comments.length === 0) return null

  const sorted = [...comments].sort((a, b) => b.createdAt - a.createdAt)

  const openCount = sorted.filter((c) => getCommentStatus(c) === 'open').length
  const repliedCount = sorted.filter((c) => getCommentStatus(c) === 'replied').length
  const resolvedCount = sorted.filter((c) => getCommentStatus(c) === 'resolved').length

  const showDiff = async (comment: ReviewComment) => {
    const title = `${comment.filePath} · since ${comment.repo ? `${comment.repo}@` : ''}${comment.commitSha!.slice(0, 7)}`
    const patch = await fetchPatchsetDiff(comment)
    setDiffView({ title, patch: patch ?? '(diff unavailable)' })
  }

  return (
    <div className="ct">
      <div className="ct-header" onClick={() => setCollapsed(!collapsed)}>
        <MessageSquare size={14} />
        <span className="ct-title">Comments</span>
        <span className="ct-counts">
          {openCount > 0 && <span className="ct-count ct-count-open">{openCount} open</span>}
          {repliedCount > 0 && <span className="ct-count ct-count-replied">{repliedCount} replied</span>}
          {resolvedCount > 0 && <span className="ct-count ct-count-resolved">{resolvedCount} resolved</span>}
        </span>
        {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </div>
      {!collapsed && (
      <>
      <ul className="ct-list">
        {sorted.map((comment) => {
          const status = getCommentStatus(comment)
          return (
            <li
              key={comment.id}
              className={`ct-item ${status === 'resolved' ? 'ct-item-resolved' : ''}`}
            >
              <button
                className="ct-item-link"
                onClick={() => onJumpToComment(comment)}
                title={`${comment.filePath}:${comment.lineNumber}`}
              >
                <div className="ct-item-header">
                  <StatusBadge status={status} />
                  <span className="ct-item-file" title={comment.filePath}>
                    {comment.filePath === COMMIT_MESSAGE
                      ? 'Commit message'
                      : `${fileName(comment.filePath)}:${comment.lineNumber}`}
                  </span>
                  {comment.commitSha && comment.filePath !== COMMIT_MESSAGE && (
                    <button
                      className="ct-diff-btn"
                      title="Show what changed since this comment"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        showDiff(comment)
                      }}
                    >
                      <GitCompare size={11} />
                    </button>
                  )}
                  <span className="ct-item-time">{timeAgo(comment.createdAt)}</span>
                </div>
                <div className="ct-item-body">{truncate(comment.body, 80)}</div>
              </button>
            </li>
          )
        })}
      </ul>
      {diffView && (
        <div className="modal-overlay" onClick={() => setDiffView(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{diffView.title}</span>
              <button className="btn btn-sm" onClick={() => setDiffView(null)}>
                Close
              </button>
            </div>
            <pre className="modal-patch">{diffView.patch || 'No changes since this comment.'}</pre>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  )
}
