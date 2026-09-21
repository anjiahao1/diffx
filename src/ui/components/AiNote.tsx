import { Bot, Save } from 'lucide-react'

interface AiNoteProps {
  note: string
  onChange: (note: string) => void
  onSave: () => void
  saved: boolean
}

// Note to the reviewing agent: persisted per review root, included at the
// top of the copied comment bundle so the agent sees it first.
export function AiNote({ note, onChange, onSave, saved }: AiNoteProps) {
  return (
    <div className="ai-note">
      <div className="ai-note-header">
        <Bot size={13} />
        <span>给 AI 的说明</span>
        <button className="btn btn-sm" onClick={onSave} title="Save the note">
          <Save size={11} />
        </button>
        {saved && <span className="ai-note-saved">已保存</span>}
      </div>
      <textarea
        className="ai-note-input"
        value={note}
        onChange={(e) => onChange(e.target.value)}
        placeholder="补充给 AI 的话,会随评论一起复制…"
        rows={4}
        spellCheck={false}
      />
    </div>
  )
}