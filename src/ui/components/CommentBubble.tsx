import { useState, useEffect } from 'react'
import { UserCircle, CheckCircle2, Bot, Reply, Send, X } from 'lucide-react'
import type { ReviewComment } from '../../types'
import { timeAgo } from '../utils'

interface CommentBubbleProps {
  comment: ReviewComment
  onDelete: (id: string) => void
  onResolve?: (id: string) => void
  onReply?: (commentId: string, body: string) => void
}

export function CommentBubble({ comment, onDelete, onResolve, onReply }: CommentBubbleProps) {
  const [, setTick] = useState(0)
  const [replying, setReplying] = useState(false)
  const [draft, setDraft] = useState('')
  const isResolved = comment.status === 'resolved'

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(timer)
  }, [])

  const submitReply = () => {
    const body = draft.trim()
    if (!body || !onReply) return
    onReply(comment.id, body)
    setDraft('')
    setReplying(false)
  }

  return (
    <div className={`comment-bubble ${isResolved ? 'comment-resolved' : ''}`} id={`comment-${comment.id}`}>
      <div className="comment-bubble-header">
        <UserCircle size={18} className="comment-bubble-avatar" />
        <span className="comment-bubble-time">{timeAgo(comment.createdAt)}</span>
        {isResolved && (
          <span className="comment-bubble-resolved">
            <CheckCircle2 size={14} />
            Resolved
          </span>
        )}
      </div>
      {typeof comment.columnStart === 'number' && typeof comment.columnEnd === 'number' && (
        <div className="comment-bubble-quote">
          {comment.lineContent.slice(comment.columnStart, comment.columnEnd)}
        </div>
      )}
      <div className="comment-bubble-body">{comment.body}</div>
      <div className="comment-bubble-actions">
        {!isResolved && onResolve && (
          <button className="comment-action" onClick={() => onResolve(comment.id)} title="Mark as resolved">
            <CheckCircle2 size={12} />
            Done
          </button>
        )}
        {!isResolved && onReply && (
          <button className="comment-action" onClick={() => setReplying(!replying)} title="Reply to this comment">
            <Reply size={12} />
            Reply
          </button>
        )}
        <button className="comment-action comment-action-close" onClick={() => onDelete(comment.id)} title="Delete comment">
          <X size={12} />
          Close
        </button>
      </div>
      {replying && (
        <div className="comment-reply-input">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitReply()
              if (e.key === 'Escape') setReplying(false)
            }}
            placeholder="Reply… (⌘/Ctrl+Enter to send)"
            rows={2}
            autoFocus
          />
          <button className="btn btn-sm" onClick={submitReply} disabled={!draft.trim()}>
            <Send size={12} />
          </button>
        </div>
      )}
      {comment.replies?.length > 0 && (
        <div className="comment-replies">
          {comment.replies.map((reply) => (
            <div key={reply.id} className="comment-reply">
              <div className="comment-reply-header">
                {reply.author === 'user' ? (
                  <UserCircle size={16} className="comment-reply-avatar" />
                ) : (
                  <Bot size={16} className="comment-reply-avatar" />
                )}
                <span className="comment-bubble-time">{timeAgo(reply.createdAt)}</span>
              </div>
              <div className="comment-reply-body">{reply.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
