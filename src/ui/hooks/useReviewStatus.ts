import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export interface ReviewStatus {
  done: boolean
  updatedAt: number | null
  counts: { open: number; replied: number; resolved: number }
}

async function fetchStatus(): Promise<ReviewStatus> {
  const res = await fetch('/api/review-status')
  return res.json()
}

// Review-completion signal: the "Done Review" button flips it, and a coding
// agent polling GET /api/review-status acts when done turns true.
export function useReviewStatus() {
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['review-status'], queryFn: fetchStatus, refetchInterval: 5000 })

  const toggleMutation = useMutation({
    mutationFn: async (done: boolean) => {
      const res = await fetch('/api/review-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done }),
      })
      return res.json() as Promise<ReviewStatus>
    },
    onSuccess: (status) => queryClient.setQueryData(['review-status'], status),
  })

  return { status: data, toggle: (done: boolean) => toggleMutation.mutate(done) }
}
