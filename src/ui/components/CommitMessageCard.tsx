import { useState } from 'react'
import { GitCommit, MessageSquarePlus, Send } from 'lucide-react'
import type { ReviewComment } from '../../types'
import { CommentBubble } from './CommentBubble'

// Synthetic file path anchoring commit-message comments; shown in the
// sidebar tracker as "Commit message" (see CommentTracker).
export const COMMIT_MESSAGE = 'COMMIT_MESSAGE'

interface CommitMessageCardProps {
  message: string
  comments: ReviewComment[]
  onAddComment: (body: string) => void
  onDeleteComment: (id: string) => void
  onResolveComment: (id: string) => void
  onReply?: (commentId: string, body: string) => void
}

// Reviewable commit-message header shown above the diff in the per-commit
// view: full subject + body, with whole-message comments.
export function CommitMessageCard({
  message,
  comments,
  onAddComment,
  onDeleteComment,
  onResolveComment,
  onReply,
}: CommitMessageCardProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const nl = message.indexOf('\n')
  const subject = nl === -1 ? message : message.slice(0, nl)
  const body = nl === -1 ? '' : message.slice(nl + 1).trim()

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    onAddComment(text)
    setDraft('')
    setOpen(false)
  }

  return (
    <div className="commit-message-card" id={`file-${COMMIT_MESSAGE}`}>
      <div className="commit-message-header">
        <GitCommit size={14} className="commit-message-icon" />
        <span className="commit-message-subject">{subject}</span>
        <button className="btn btn-sm" onClick={() => setOpen(!open)} title="Comment on the commit message">
          <MessageSquarePlus size={12} />
          {open ? 'Cancel' : 'Comment'}
        </button>
      </div>
      {body && <pre className="commit-message-body">{body}</pre>}
      {open && (
        <div className="commit-message-input">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
              if (e.key === 'Escape') setOpen(false)
            }}
            placeholder="Comment on the commit message… (⌘/Ctrl+Enter to send)"
            rows={3}
            autoFocus
          />
          <button className="btn btn-sm btn-primary" onClick={submit} disabled={!draft.trim()}>
            <Send size={12} />
          </button>
        </div>
      )}
      {comments.length > 0 && (
        <div className="commit-message-comments">
          {comments.map((c) => (
            <CommentBubble
              key={c.id}
              comment={c}
              onDelete={onDeleteComment}
              onResolve={onResolveComment}
              onReply={onReply}
            />
          ))}
        </div>
      )}
    </div>
  )
}