import { CheckCircle2 } from 'lucide-react'
import { useReviewStatus } from '../hooks/useReviewStatus'

// Independent of CommentTracker (which hides itself when there are no
// comments) so the signal can be sent even on a comment-free review.
export function ReviewDoneButton() {
  const { status, toggle } = useReviewStatus()
  const done = status?.done ?? false
  return (
    <button
      className={`btn btn-sm review-done-btn ${done ? 'review-done-active' : ''}`}
      onClick={() => toggle(!done)}
      title={done ? 'Review done — click to reopen the review' : 'Signal the agent that the review is complete'}
    >
      {done && <CheckCircle2 size={14} />}
      {done ? 'Review done' : 'Done Review'}
    </button>
  )
}
