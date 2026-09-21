import { useQuery } from '@tanstack/react-query'

export interface CommitInfo {
  sha: string
  subject: string
  date: string
}

export interface RepoCommits {
  repo: string
  branch: string
  commits: CommitInfo[]
}

async function fetchCommits(): Promise<RepoCommits[]> {
  const res = await fetch('/api/commits')
  if (!res.ok) return []
  return res.json()
}

// Unpushed commits per repo (@{u}..HEAD), for the per-commit review list.
export function useCommits() {
  const { data = [] } = useQuery({ queryKey: ['commits'], queryFn: fetchCommits, refetchInterval: 15000 })
  return data
}
