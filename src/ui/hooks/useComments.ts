import { useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { DiffLineAnnotation } from '@pierre/diffs'
import type { ReviewComment } from '../../types'

const COMMENTS_KEY = ['comments']

async function fetchComments(): Promise<ReviewComment[]> {
  const res = await fetch('/api/comments')
  return res.json()
}

export function useComments() {
  const queryClient = useQueryClient()
  const { data: comments = [] } = useQuery({ queryKey: COMMENTS_KEY, queryFn: fetchComments, refetchInterval: 3000 })

  const addMutation = useMutation({
    mutationFn: async (params: { filePath: string; side: 'deletions' | 'additions'; lineNumber: number; lineContent: string; body: string; repo?: string; commitSha?: string; fileOid?: string; columnStart?: number; columnEnd?: number }) => {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      return res.json() as Promise<ReviewComment>
    },
    onSuccess: (comment) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) => [...prev, comment])
    },
  })

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/comments/${id}`, { method: 'DELETE' })
      return id
    },
    onSuccess: (id) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) => prev.filter((c) => c.id !== id))
    },
  })

  const editMutation = useMutation({
    mutationFn: async ({ id, body, status }: { id: string; body?: string; status?: ReviewComment['status'] }) => {
      const res = await fetch(`/api/comments/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, status }),
      })
      return res.json() as Promise<ReviewComment>
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      )
    },
  })

  const replyMutation = useMutation({
    mutationFn: async ({ commentId, body }: { commentId: string; body: string }) => {
      const res = await fetch(`/api/comments/${commentId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, author: 'user' }),
      })
      return res.json() as Promise<ReviewComment>
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<ReviewComment[]>(COMMENTS_KEY, (prev = []) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      )
    },
  })

  const addComment = useCallback(
    (
      filePath: string,
      side: 'deletions' | 'additions',
      lineNumber: number,
      lineContent: string,
      body: string,
      ctx?: { repo?: string; commitSha?: string; fileOid?: string; columnStart?: number; columnEnd?: number },
    ) => {
      addMutation.mutate({ filePath, side, lineNumber, lineContent, body, ...ctx })
    },
    [addMutation],
  )

  const removeComment = useCallback(
    (id: string) => {
      removeMutation.mutate(id)
    },
    [removeMutation],
  )

  const addReply = useCallback(
    (commentId: string, body: string) => {
      replyMutation.mutate({ commentId, body })
    },
    [replyMutation],
  )

  const editComment = useCallback(
    (id: string, body: string) => {
      editMutation.mutate({ id, body })
    },
    [editMutation],
  )

  const resolveComment = useCallback(
    (id: string) => {
      editMutation.mutate({ id, status: 'resolved' })
    },
    [editMutation],
  )

  const formatAllComments = useCallback((aiNote: string): string => {
    const note = aiNote.trim()
    if (comments.length === 0 && !note) return ''

    const lines: string[] = []
    if (note) {
      lines.push(`<ai-instructions>${note}</ai-instructions>`)
      lines.push('')
    }
    lines.push('<code-review-comments>')

    const grouped = new Map<string, ReviewComment[]>()
    for (const comment of comments) {
      const list = grouped.get(comment.filePath) ?? []
      list.push(comment)
      grouped.set(comment.filePath, list)
    }
    for (const [filePath, fileComments] of grouped) {
      // Commit-anchored comments carry their commit so the agent knows which
      // commit to amend.
      const commit = fileComments.find((c) => c.commitSha)
      const commitAttr = commit ? ` commit="${commit.repo ? `${commit.repo}@` : ''}${commit.commitSha!.slice(0, 7)}"` : ''
      lines.push(`<file path="${filePath}"${commitAttr}>`)
      for (const comment of fileComments) {
        const hasColumn = typeof comment.columnStart === 'number' && typeof comment.columnEnd === 'number'
        const columnAttr = hasColumn ? ` column="${comment.columnStart}-${comment.columnEnd}"` : ''
        lines.push(`<comment line="${comment.lineNumber}"${columnAttr}>`)
        // A column-anchored comment quotes the selected stretch of the line.
        const code = hasColumn
          ? comment.lineContent.slice(comment.columnStart, comment.columnEnd)
          : comment.lineContent
        const prefix = comment.side === 'additions' ? '+' : '-'
        lines.push(`<code>${prefix} ${code}</code>`)
        lines.push(comment.body)
        lines.push('</comment>')
      }
      lines.push('</file>')
    }
    lines.push('</code-review-comments>')

    return lines.join('\n')
  }, [comments])

  const getAnnotationsForFile = useCallback(
    (filePath: string): DiffLineAnnotation<ReviewComment>[] => {
      return comments
        .filter((c) => c.filePath === filePath)
        .map((c) => ({
          side: c.side,
          lineNumber: c.lineNumber,
          metadata: c,
        }))
    },
    [comments],
  )

  const copyAllComments = useCallback(async (aiNote: string) => {
    const text = formatAllComments(aiNote)
    await navigator.clipboard.writeText(text)
  }, [formatAllComments])

  return {
    comments,
    addComment,
    removeComment,
    addReply,
    editComment,
    resolveComment,
    getAnnotationsForFile,
    formatAllComments,
    copyAllComments,
  }
}
