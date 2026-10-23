import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileDiffMetadata } from '@pierre/diffs'
import { Search, X } from 'lucide-react'
import { searchDiff } from '../search'
import type { SearchHit } from '../search'

// ponytail: one capped list keeps the panel cheap; paginate if 200 is ever too few.
const RESULT_LIMIT = 200
const MATCH_CONTEXT = 80

interface SearchPanelProps {
  files: FileDiffMetadata[]
  onJump: (hit: SearchHit) => void
}

export function SearchPanel({ files, onJump }: SearchPanelProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  const results = useMemo(() => searchDiff(files, query, RESULT_LIMIT), [files, query])
  const current = Math.min(active, Math.max(results.length - 1, 0))

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setOpen(true)
        requestAnimationFrame(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        })
      } else if (event.key === 'Escape' && open) {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [current, results])

  if (!open) return null

  const move = (next: number) => {
    if (results.length > 0) setActive(Math.max(0, Math.min(results.length - 1, next)))
  }

  return (
    <div className="search-panel" role="dialog" aria-label="Search diff">
      <div className="search-panel-header">
        <Search size={14} className="search-panel-icon" />
        <input
          ref={inputRef}
          className="search-panel-input"
          value={query}
          placeholder="Search diff lines..."
          aria-label="Search diff"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              move(current + 1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              move(current - 1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              const hit = results[current]
              if (hit) onJump(hit)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          }}
        />
        <span className="search-panel-count">
          {query.trim() === ''
            ? ''
            : results.length === 0
              ? 'No matches'
              : `${results.length}${results.length >= RESULT_LIMIT ? '+' : ''}`}
        </span>
        <button className="search-panel-close" onClick={close} title="Close (Esc)" aria-label="Close search">
          <X size={14} />
        </button>
      </div>
      {query.trim() !== '' && (
        <div className="search-results">
          {results.length === 0 ? (
            <div className="search-empty">No matches</div>
          ) : (
            results.map((hit, index) => (
              <button
                key={`${hit.filePath}\0${hit.side}\0${hit.lineNumber}\0${hit.start}`}
                ref={index === current ? activeRef : undefined}
                className={`search-result ${index === current ? 'search-result-active' : ''}`}
                // Keep the query input focused while clicking a result.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onJump(hit)}
              >
                <span className="search-result-loc" title={`${hit.filePath}:${hit.lineNumber}`}>
                  {hit.filePath}:{hit.lineNumber}
                </span>
                <span className={`search-result-side ${hit.side}`}>{hit.side === 'additions' ? '+' : '-'}</span>
                <span className="search-result-text">{renderMatch(hit)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function renderMatch(hit: SearchHit) {
  const from = Math.max(0, hit.start - MATCH_CONTEXT)
  const to = Math.min(hit.text.length, hit.start + hit.length + MATCH_CONTEXT)
  return (
    <>
      {from > 0 && '...'}
      {hit.text.slice(from, hit.start)}
      <mark>{hit.text.slice(hit.start, hit.start + hit.length)}</mark>
      {hit.text.slice(hit.start + hit.length, to)}
      {to < hit.text.length && '...'}
    </>
  )
}
