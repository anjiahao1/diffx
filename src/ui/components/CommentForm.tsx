import { useState, useRef, useEffect } from 'react'

interface CommentFormProps {
  onSubmit: (body: string) => void
  onCancel: () => void
  // Text the comment anchors to (selected in the line); shown as a quote.
  quote?: string
}

export function CommentForm({ onSubmit, onCancel, quote }: CommentFormProps) {
  const [body, setBody] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleSubmit = () => {
    const trimmed = body.trim()
    if (trimmed) {
      onSubmit(trimmed)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div className="comment-form">
      {quote && <div className="comment-form-quote">{quote}</div>}
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Leave a review comment..."
        rows={3}
      />
      <div className="comment-form-actions">
        <button className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={handleSubmit} disabled={!body.trim()}>
          Comment
        </button>
      </div>
    </div>
  )
}
