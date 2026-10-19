import { type CSSProperties, type ReactNode, type UIEvent, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AlertCircle,
  Activity,
  Pause,
  Play,
  RotateCcw,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FileArchive,
  FileCode2,
  FileUp,
  FileText,
  Filter,
  GitCompare,
  Info,
  Link2,
  Loader2,
  Maximize2,
  Minimize2,
  Save,
  Search,
  Replace,
  ShieldCheck,
  SlidersHorizontal,
  SortAsc,
  SortDesc,
  X,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { TreeEditor, type TreeJsonValue } from '@/components/tree-editor';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
const API_BASE_URL = (import.meta.env.VITE_UNITY_API_BASE_URL ?? '').replace(/\/+$/, '');
const apiUrl = (path: string) => /^https?:\/\//i.test(path)
  ? path
  : `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
const ACTIVE_SESSION_KEY = 'unity-asset-inspector:active-session';
const SELECTED_OBJECT_KEY = 'unity-asset-inspector:selected-object:';
const DRAFT_KEY = 'unity-asset-inspector:draft:';

function getStoredValue(key: string) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStoredValue(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStoredValue(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // The app remains usable when browser storage is restricted.
  }
}

function clearSessionDrafts(sessionId: string) {
  const prefix = `${DRAFT_KEY}${sessionId}:`;
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(prefix)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // Draft cleanup is best-effort; it must not block opening another file.
  }
}

function draftStorageKey(sessionId: string, pathId: string) {
  return `${DRAFT_KEY}${sessionId}:${pathId}`;
}

function parseTreeValue(text: string): TreeJsonValue | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as TreeJsonValue
      : null;
  } catch {
    return null;
  }
}

type AssetRecord = {
  path_id: string;
  name: string;
  size: number;
  class_name: string;
  editable: boolean;
  parse_error: string | null;
  dirty: boolean;
  search_text?: string;
};

type SessionData = {
  session_id: string;
  file_name: string;
  file_size: number;
  objects: AssetRecord[];
  total_objects: number;
  classes?: string[] | Record<string, number>;
};

type DetailResponse = AssetRecord & { json: Record<string, unknown> | null };
type Notice = { tone: 'error' | 'success' | 'info'; text: string } | null;
type Tab = 'preview' | 'type' | 'inspect' | 'animation' | 'changes' | 'references';
type SortKey = 'name' | 'class_name' | 'path_id' | 'size';
type SavedSearch = { name: string; query: string; className: string; dirtyOnly: boolean };
type ObjectReference = { pathId: string; fileId: string; fieldPath: string };
type ComparisonEntry = { path_id: string; before?: AssetRecord; after?: AssetRecord; kind: 'added' | 'removed' | 'changed' };
type BundleComparison = { session_id: string; file_name: string; entries: ComparisonEntry[]; unchanged: number };

const SAVED_SEARCHES_KEY = 'xenon-unitypy:saved-searches';

function readSavedSearches(): SavedSearch[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(SAVED_SEARCHES_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item) => item && typeof item.name === 'string' && typeof item.query === 'string') : [];
  } catch { return []; }
}

function downloadJsonFile(fileName: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function diffJson(original: unknown, edited: unknown) {
  const changes: { path: string; before: unknown; after: unknown }[] = [];
  const walk = (before: unknown, after: unknown, path: string) => {
    if (Object.is(before, after)) return;
    if (before && after && typeof before === 'object' && typeof after === 'object' &&
        Array.isArray(before) === Array.isArray(after)) {
      const beforeObject = before as Record<string, unknown>;
      const afterObject = after as Record<string, unknown>;
      const keys = new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)]);
      for (const key of keys) walk(beforeObject[key], afterObject[key], Array.isArray(before) ? `${path}[${key}]` : `${path}.${key}`);
      return;
    }
    changes.push({ path: path || '$', before, after });
  };
  walk(original, edited, '$');
  return changes;
}

function displayDiffValue(value: unknown) {
  if (value === undefined) return '(missing)';
  if (typeof value === 'string') return JSON.stringify(value);
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

const formatBytes = (bytes = 0) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
};

const objectName = (record: AssetRecord) => record.name || String(record.path_id);
const objectClass = (record: AssetRecord) => record.class_name || 'MonoBehaviour';

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

function highlightedJson(value: string) {
  const tokenPattern = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  let output = '';
  let cursor = 0;
  for (const match of value.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    output += escapeHtml(value.slice(cursor, index));
    const token = escapeHtml(match[0]);
    if (match[2]) {
      const keyLength = escapeHtml(match[1] ?? '').length;
      output += `<span class="json-key">${token.slice(0, keyLength)}</span>${token.slice(keyLength)}`;
    } else if (match[1]) output += `<span class="json-string">${token}</span>`;
    else if (match[3]) output += `<span class="json-number">${token}</span>`;
    else output += `<span class="json-literal">${token}</span>`;
    cursor = index + match[0].length;
  }
  return output + escapeHtml(value.slice(cursor));
}

async function apiErrorMessage(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: string; message?: string };
    const message = payload.error || payload.message;
    if (message) return message;
  } catch {
    // Infrastructure errors may not have a JSON body.
  }
  return `${fallback} (${response.status})`;
}

function StatusBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  if (!notice) return null;
  return (
    <div className={`notice ${notice.tone}`} role="status">
      {notice.tone === 'error' ? <AlertCircle size={16} /> : notice.tone === 'success' ? <Check size={16} /> : <Info size={16} />}
      <span>{notice.text}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss message"><X size={15} /></button>
    </div>
  );
}

function UploadDropzone({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const acceptFile = (file?: File) => { if (file) onFile(file); };
  return (
    <div
      className={`upload-card ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); acceptFile(event.dataTransfer.files[0]); }}
      data-testid="dropzone-asset"
    >
      <input ref={inputRef} type="file" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; acceptFile(file); }} data-testid="input-asset-file" />
      <div className="upload-icon"><FileArchive size={24} /></div>
      <div className="upload-copy">
        <strong>{busy ? 'Reading file…' : 'Open a Unity asset file'}</strong>
        <span>Choose any file. The server will determine whether it is a readable Unity asset.</span>
      </div>
      <button type="button" className="small-button primary" disabled={busy} onClick={() => inputRef.current?.click()} data-testid="button-browse-file">
        {busy ? <Loader2 size={15} className="animate-spin" /> : <FileUp size={15} />} Browse
      </button>
    </div>
  );
}

function EmptyWorkspace({ onFile, busy }: { onFile: (file: File) => void; busy: boolean }) {
  return (
    <main className="empty-workspace">
      <div className="empty-card">
        <div className="empty-mark"><FileCode2 size={27} /></div>
        <p className="eyebrow">XENON UNITYPY / ASSET WORKBENCH</p>
        <h1>Inspect the build.<br/><span>Control the data.</span></h1>
        <p className="empty-copy">A focused workspace for searching Unity MonoBehaviour data, reviewing complete type trees, editing supported values, and exporting a repacked bundle.</p>
        <UploadDropzone onFile={onFile} busy={busy} />
        <div className="empty-features">
          <span><Search size={14} /> Search object records</span>
          <span><Code2 size={14} /> Edit readable JSON</span>
          <span><Download size={14} /> Export a repacked file</span>
        </div>
      </div>
    </main>
  );
}

function AppHeader({ fileName, onNew, onRepack, repacking }: { fileName?: string; onNew: () => void; onRepack?: () => void; repacking?: boolean }) {
  return (
    <header className="app-header">
      <div className="app-brand"><span className="brand-icon"><FileCode2 size={18} /></span><div><strong>XENON UNITYPY</strong><span>Asset intelligence · editor workspace</span></div></div>
      <div className="app-header-actions">
        <span className="active-file" title={fileName}>{fileName || 'No file open'}</span>
        <button type="button" className="small-button" onClick={onNew}>Open file</button>
        {fileName && onRepack && <button type="button" className="small-button primary" onClick={onRepack} disabled={repacking}>{repacking ? 'Repacking…' : <><Download size={13} /> Repack & download</>}</button>}
      </div>
    </header>
  );
}

function SortIndicator({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  return active ? (direction === 'asc' ? <SortAsc size={14} className="sort-mark selected" /> : <SortDesc size={14} className="sort-mark selected" />) : <span className="sort-mark">↕</span>;
}

function AssetTable({ objects, totalObjects, selectedId, onSelect, search, caseSensitive, showUnreadable, dirtyOnly, classFilter, sortKey, direction, onSort }: {
  objects: AssetRecord[]; totalObjects: number; selectedId: string | null; onSelect: (record: AssetRecord) => void; search: string; caseSensitive: boolean;
  showUnreadable: boolean; dirtyOnly: boolean; classFilter: string; sortKey: SortKey; direction: 'asc' | 'desc'; onSort: (key: SortKey) => void;
}) {
  const visible = useMemo(() => {
    const query = caseSensitive ? search.trim() : search.trim().toLowerCase();
    const rows = objects.filter((record) => {
      if (!showUnreadable && !record.editable) return false;
      if (dirtyOnly && !record.dirty) return false;
      if (classFilter && record.class_name !== classFilter) return false;
      if (!query) return true;
      const haystack = [objectName(record), objectClass(record), String(record.path_id), record.search_text || ''].join(' ');
      return (caseSensitive ? haystack : haystack.toLowerCase()).includes(query);
    });
    return rows.sort((a, b) => {
      const left = String(a[sortKey] ?? '').toLowerCase();
      const right = String(b[sortKey] ?? '').toLowerCase();
      const result = sortKey === 'size' ? Number(a.size) - Number(b.size) : left.localeCompare(right, undefined, { numeric: true });
      return direction === 'asc' ? result : -result;
    });
  }, [caseSensitive, classFilter, direction, dirtyOnly, objects, search, showUnreadable, sortKey]);

  return (
    <>
      <div className="asset-table-wrap">
        {visible.length === 0 ? <div className="asset-empty"><Search size={22} /><p>No matching objects</p><span>Try a different search or enable unreadable objects.</span></div> : (
          <table className="asset-table">
            <thead><tr>
              <th><button type="button" className="th-label" onClick={() => onSort('name')}>Name <SortIndicator active={sortKey === 'name'} direction={direction} /></button></th>
              <th><span className="th-label">Type <Filter size={13} color="#aeb4b7" /></span></th>
              <th><button type="button" className="th-label" onClick={() => onSort('path_id')}>PathID <SortIndicator active={sortKey === 'path_id'} direction={direction} /></button></th>
              <th><button type="button" className="th-label" onClick={() => onSort('size')}>Size <SortIndicator active={sortKey === 'size'} direction={direction} /></button></th>
            </tr></thead>
            <tbody>{visible.map((record) => {
              const id = String(record.path_id);
              return <tr key={id} className={`${id === selectedId ? 'selected' : ''} ${record.editable ? '' : 'unreadable'}`} onClick={() => onSelect(record)} data-testid={`button-object-${id}`}>
                <td title={objectName(record)}><span className="asset-name">{objectName(record)}</span>{record.dirty && <span className="dirty-indicator" title="Saved in this session">EDITED</span>}</td><td title={objectClass(record)}>{objectClass(record)}</td><td title={String(record.path_id)}>{record.path_id}</td><td>{formatBytes(record.size)}</td>
              </tr>;
            })}</tbody>
          </table>
        )}
      </div>
      <div className="table-status">{visible.length} of {totalObjects} objects {showUnreadable ? '' : '· unreadable hidden'}</div>
    </>
  );
}

function TreeNode({ label, value, depth = 0 }: { label: string; value: unknown; depth?: number }) {
  const expandable = typeof value === 'object' && value !== null;
  const [expanded, setExpanded] = useState(depth < 1);
  const entries = expandable ? Object.entries(value as Record<string, unknown>) : [];
  const typeLabel = Array.isArray(value) ? `Array<${value.length}>` : 'object';
  const primitiveClass = value === null ? 'null' : typeof value;
  const renderValue = () => {
    if (value === null) return 'null';
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    return typeLabel;
  };
  return (
    <div>
      <div className="tree-row" style={{ paddingLeft: depth * 22 }}>
        {expandable ? <button type="button" className="tree-toggle" aria-label={expanded ? 'Collapse node' : 'Expand node'} onClick={() => setExpanded((current) => !current)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="tree-spacer" />}
        <span className="tree-key">{label}</span><span>:</span>
        <span className={`tree-value ${expandable ? 'tree-type' : primitiveClass}`}>{renderValue()}</span>
      </div>
      {expanded && entries.map(([childKey, childValue]) => <TreeNode key={childKey} label={childKey} value={childValue} depth={depth + 1} />)}
    </div>
  );
}

function AnimationPanel({ record, detail }: { record: AssetRecord | null; detail: DetailResponse | null }) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(5);
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setTime((current) => {
      const next = current + 0.05 * speed;
      if (next >= duration) { setPlaying(false); return duration; }
      return next;
    }), 50);
    return () => window.clearInterval(timer);
  }, [playing, speed, duration]);
  useEffect(() => { setTime(0); setPlaying(false); }, [record?.path_id]);
  const className = record?.class_name || '';
  const likelyAnimation = /animation|animator|controller|avatar|motion/i.test(className + ' ' + (record?.name || ''));
  const json = detail?.json || {};
  const tracks = Object.entries(json).filter(([key, value]) => /curve|track|binding|clip|key|sample|m_position|m_rotation|m_scale|muscle/i.test(key) && (Array.isArray(value) || (value && typeof value === 'object'))).slice(0, 8);
  return <div className="animation-lab">
    <div className="animation-title-row"><div><span className="eyebrow">MOTION WORKSPACE</span><h2>Animation Lab</h2><p>Inspect animation-related serialized data and timeline position.</p></div><span className="motion-chip"><Activity size={13} /> {likelyAnimation ? 'Animation-related asset' : 'Generic asset timeline'}</span></div>
    <div className="motion-preview"><div className="motion-orbit orbit-one"/><div className="motion-orbit orbit-two"/><div className="motion-object"><div className="motion-cube"/></div><div className="motion-preview-label"><span className="live-dot"/> Timeline preview · {time.toFixed(2)}s</div></div>
    <div className="timeline-card">
      <div className="timeline-toolbar"><div className="transport-controls"><button type="button" aria-label={playing ? 'Pause timeline' : 'Play timeline'} onClick={() => setPlaying((v) => !v)} className="transport-main">{playing ? <Pause size={16}/> : <Play size={16}/>}</button><button type="button" aria-label="Reset timeline" onClick={() => { setTime(0); setPlaying(false); }}><RotateCcw size={15}/></button><span className="time-readout">{time.toFixed(2)} <i>/</i> {duration.toFixed(2)} s</span></div><label className="speed-select">Speed <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}><option value={0.25}>0.25×</option><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select></label></div>
      <div className="timeline-ruler"><span>0s</span><span>{(duration/4).toFixed(1)}s</span><span>{(duration/2).toFixed(1)}s</span><span>{(duration*0.75).toFixed(1)}s</span><span>{duration}s</span></div>
       <div className="timeline-scrubber"><input aria-label="Timeline position" type="range" min="0" max={duration} step="0.01" value={time} onChange={(e) => { setTime(Number(e.target.value)); setPlaying(false); }} style={{'--timeline-progress': `${time / duration * 100}%`} as CSSProperties}/><div className="timeline-track"><span className="timeline-key key-a"/><span className="timeline-key key-b"/><span className="timeline-key key-c"/><span className="timeline-key key-d"/><span className="timeline-playhead" style={{left: `${time / duration * 100}%`}}/></div></div>
      <div className="duration-row"><label>Clip length <input type="number" min="0.1" max="600" step="0.1" value={duration} onChange={(e) => { const n = Math.max(0.1, Math.min(600, Number(e.target.value) || 0.1)); setDuration(n); setTime((t) => Math.min(t, n)); }}/></label><span className="read-only-note">Local timeline controls</span></div>
    </div>
    <div className="track-card"><div className="track-card-head"><div><h3>Detected tracks & data</h3><p>Fields found in the selected object's JSON payload</p></div><span className="track-count">{tracks.length} fields</span></div>{tracks.length ? tracks.map(([key, value], i) => <div className="track-row" key={key}><span className={`track-swatch swatch-${i%4}`}/><span className="track-name">{key}</span><span className="track-kind">{Array.isArray(value) ? `${value.length} items` : 'object'}</span><span className="track-mini-keys"><i/><i/><i/></span></div>) : <div className="track-empty"><Activity size={18}/><div><strong>No obvious animation tracks detected</strong><span>Choose an AnimationClip, Animator, or related asset to inspect animation fields. The JSON editor remains available for supported serialized data.</span></div></div>}</div>
    <div className="animation-disclaimer">This is an animation inspection/timeline UI, not a Unity runtime renderer. Changing the timeline does not modify the asset. Edit supported serialized fields in <b>Inspect / JSON</b>, then save and repack with the backend.</div>
  </div>;
}

function findObjectReferences(value: unknown) {
  const found: ObjectReference[] = [];
  const visit = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const object = node as Record<string, unknown>;
    const pathValue = object.m_PathID ?? object.path_id ?? object.PathID;
    if ((typeof pathValue === 'string' || typeof pathValue === 'number') && String(pathValue) !== '0') {
      found.push({
        pathId: String(pathValue),
        fileId: String(object.m_FileID ?? object.file_id ?? 0),
        fieldPath: path,
      });
    }
    for (const [key, child] of Object.entries(object)) visit(child, `${path}.${key}`);
  };
  visit(value, '$');
  const unique = new Map(found.map((reference) => [`${reference.fileId}:${reference.pathId}`, reference]));
  return [...unique.values()];
}

function ReferencePanel({ detail, objects, onNavigate }: { detail: DetailResponse | null; objects: AssetRecord[]; onNavigate: (record: AssetRecord) => void }) {
  const references = useMemo(() => findObjectReferences(detail?.json), [detail?.json]);
  const localByPath = useMemo(() => new Map(objects.map((object) => [String(object.path_id), object])), [objects]);
  return <div className="reference-panel">
    <div className="reference-heading"><div><span className="eyebrow">OBJECT POINTERS</span><h2>Reference navigator</h2><p>References are extracted from the selected MonoBehaviour's serialized JSON. Only MonoBehaviour records are indexed for opening.</p></div><span>{references.length} links</span></div>
    {references.length ? <div className="reference-list">{references.map((reference) => {
      const local = reference.fileId === '0' ? localByPath.get(reference.pathId) : undefined;
      return <article className="reference-item" key={`${reference.fileId}:${reference.pathId}`}>
        <Link2 size={15}/>
        <div><code>{reference.fieldPath}</code><span>File {reference.fileId} · Path {reference.pathId}</span></div>
        {local ? <button type="button" className="small-button" onClick={() => onNavigate(local)}>{objectName(local)}</button> : <span className="reference-external">{reference.fileId === '0' ? 'Outside editable index' : 'External file'}</span>}
      </article>;
    })}</div> : <div className="diff-empty"><Info size={19}/><span>No serialized PPtr fields were found in this object.</span></div>}
    <p className="reference-note">A reference not listed in this MonoBehaviour index is not necessarily broken; the target may be a different Unity object type or another asset file.</p>
  </div>;
}

function DetailPane({ record, detail, loading, tab, setTab, jsonText, originalJsonText, setJsonText, treeValue, onTreeChange, editorState, onValidate, onSave, onUndo, onRedo, canUndo, canRedo, saving, onClose, objects, onNavigate }: {
  record: AssetRecord | null; detail: DetailResponse | null; loading: boolean; tab: Tab; setTab: (tab: Tab) => void; jsonText: string;
  originalJsonText: string;
  setJsonText: (value: string) => void; treeValue: TreeJsonValue | null; onTreeChange: (value: TreeJsonValue) => void;
  editorState: 'idle' | 'valid' | 'invalid' | 'saved'; onValidate: () => void; onSave: () => void; onUndo: () => void; onRedo: () => void;
  canUndo: boolean; canRedo: boolean; saving: boolean; onClose: () => void; objects: AssetRecord[]; onNavigate: (record: AssetRecord) => void;
}) {
  const lineCount = Math.max(1, jsonText.split('\n').length);
  const showEmpty = !record;
  const [typeFullscreen, setTypeFullscreen] = useState(false);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const highlightedCodeRef = useRef<HTMLPreElement>(null);
  const changes = useMemo(() => {
    try { return diffJson(JSON.parse(originalJsonText), JSON.parse(jsonText)); }
    catch { return []; }
  }, [jsonText, originalJsonText]);

  const syncJsonEditorScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = scrollTop;
    if (highlightedCodeRef.current) {
      highlightedCodeRef.current.scrollTop = scrollTop;
      highlightedCodeRef.current.scrollLeft = scrollLeft;
    }
  };

  useEffect(() => {
    if (!typeFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTypeFullscreen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', exitOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', exitOnEscape);
    };
  }, [typeFullscreen]);

  useEffect(() => {
    setTypeFullscreen(false);
  }, [record?.path_id, tab]);

  return (
    <section className="detail-pane" data-testid="panel-record-detail">
      <div className="tabs">
        <button type="button" className={`tab ${tab === 'preview' ? 'active' : ''}`} onClick={() => setTab('preview')}>Preview</button>
        <button type="button" className={`tab ${tab === 'type' ? 'active' : ''}`} onClick={() => setTab('type')}>Type tree</button>
        <button type="button" className={`tab ${tab === 'inspect' ? 'active' : ''}`} onClick={() => setTab('inspect')}>Tree editor</button>
        <button type="button" className={`tab ${tab === 'changes' ? 'active' : ''}`} onClick={() => setTab('changes')}>Changes <span className="tab-count">{changes.length}</span></button>
        <button type="button" className={`tab ${tab === 'references' ? 'active' : ''}`} onClick={() => setTab('references')}><Link2 size={14}/> References</button>
        <button type="button" className={`tab ${tab === 'animation' ? 'active' : ''}`} onClick={() => setTab('animation')}><Activity size={14}/> Animation</button>
        <button type="button" className="mobile-only tab" onClick={onClose} aria-label="Close asset list"><X size={16} /></button>
      </div>
      <div className="detail-body">
        {showEmpty ? <div className="empty-detail"><FileCode2 size={30} /><p>Select an object to inspect</p><span>Choose a row from the asset table to load its serialized data.</span></div> : loading ? <div className="empty-detail"><Loader2 size={26} className="animate-spin" /><p>Loading object…</p></div> : tab === 'preview' ? (
          <div className="preview-panel">
            <h2 className="preview-heading">{objectName(record)}</h2>
            <dl className="meta-grid">
              <div className="meta-item"><dt>Type</dt><dd>{objectClass(record)}</dd></div>
              <div className="meta-item"><dt>PathID</dt><dd className="mono">{record.path_id}</dd></div>
              <div className="meta-item"><dt>Serialized size</dt><dd>{formatBytes(record.size)}</dd></div>
              <div className="meta-item"><dt>State</dt><dd className={record.editable ? 'state-tag' : 'state-tag warn'}>{record.editable ? 'Readable and editable' : 'View only'}</dd></div>
              <div className="meta-item"><dt>Session</dt><dd className="mono">{detail?.dirty ? 'Modified' : 'Original'}</dd></div>
              <div className="meta-item"><dt>Parse status</dt><dd>{record.parse_error || 'Type tree loaded'}</dd></div>
            </dl>
            {!record.editable && <div className="editor-note error" style={{ marginTop: 16 }}>{record.parse_error || 'This object could not be decoded and is view only.'}</div>}
          </div>
        ) : tab === 'animation' ? (
          <AnimationPanel record={record} detail={detail} />
        ) : tab === 'inspect' ? (
          treeValue && record.editable ? (
            <TreeEditor
              value={treeValue}
              rootName={objectClass(record)}
              saving={saving}
              editorState={editorState}
              onChange={onTreeChange}
              onSave={onSave}
              onUndo={onUndo}
              onRedo={onRedo}
              canUndo={canUndo}
              canRedo={canRedo}
            />
          ) : detail?.json && !record.editable ? (
            <div className="inspect-panel"><TreeNode label={objectClass(record)} value={detail.json} /></div>
          ) : treeValue === null && record.editable ? (
            <div className="empty-detail">
              <AlertCircle size={26} />
              <p>The JSON draft needs fixing</p>
              <span>Correct the JSON in the Type tree tab before editing it here.</span>
              <button type="button" className="small-button" onClick={() => setTab('type')}>Open Type tree</button>
            </div>
          ) : (
            <div className="empty-detail"><AlertCircle size={26} /><p>No structured view available</p><span>{record.parse_error || 'This object did not return JSON.'}</span></div>
          )
        ) : tab === 'changes' ? (
          <div className="changes-panel">
            <div className="changes-heading"><div><span className="eyebrow">SAVED BASELINE / CURRENT DRAFT</span><h2>Change review</h2><p>Compare this object with the version first loaded into this browser session.</p></div><strong>{changes.length} {changes.length === 1 ? 'change' : 'changes'}</strong></div>
            {changes.length ? <div className="diff-list">{changes.map((change) => <article className="diff-item" key={change.path}><code>{change.path}</code><div className="diff-values"><pre className="diff-before">− {displayDiffValue(change.before)}</pre><pre className="diff-after">+ {displayDiffValue(change.after)}</pre></div></article>)}</div> : <div className="diff-empty"><Check size={20}/><span>{editorState === 'invalid' ? 'The current draft is not valid JSON, so it cannot be compared yet.' : 'No saved-versus-draft differences for this object.'}</span></div>}
          </div>
        ) : tab === 'references' ? (
          <ReferencePanel detail={detail} objects={objects} onNavigate={onNavigate} />
        ) : (
          <div className={`workbench ${typeFullscreen ? 'is-fullscreen' : ''}`}>
            <div className="workbench-toolbar"><span className="workbench-title">serialized.json · {lineCount} lines</span><div className="workbench-actions"><button type="button" className="small-button" onClick={onValidate} data-testid="button-validate-json"><Check size={13} /> Validate</button><button type="button" className="small-button primary" disabled={saving || !record.editable || editorState === 'invalid'} onClick={onSave} data-testid="button-save-json">{saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save changes</button><button type="button" className="small-button type-fullscreen-button" onClick={() => setTypeFullscreen((current) => !current)} aria-label={typeFullscreen ? 'Exit full screen Type tree editor' : 'Open full screen Type tree editor'} title={typeFullscreen ? 'Exit full screen' : 'Open full screen editor'} data-testid="button-fullscreen-json">{typeFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}<span className="type-fullscreen-label">{typeFullscreen ? 'Exit full screen' : 'Full screen'}</span></button></div></div>
             {record.editable ? <div className="json-editor"><div ref={lineNumbersRef} className="line-numbers" aria-hidden="true">{Array.from({ length: lineCount }, (_, index) => <div key={index}>{index + 1}</div>)}</div><div className="code-area"><pre ref={highlightedCodeRef} className="code-highlight" aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlightedJson(jsonText) }} /><textarea value={jsonText} onChange={(event) => setJsonText(event.target.value)} onScroll={syncJsonEditorScroll} disabled={saving} spellCheck={false} aria-label="Serialized JSON editor" className="code-input" data-testid="textarea-json-editor" /></div></div> : <div className="empty-detail"><AlertCircle size={26} /><p>View only object</p><span>{record.parse_error || 'UnityPy could not provide an editable type tree for this object.'}</span></div>}
            <div className={`editor-note ${editorState === 'invalid' ? 'error' : ''}`}>{editorState === 'invalid' ? 'Invalid JSON. Fix syntax before saving.' : editorState === 'saved' ? 'Changes saved to the active session.' : record.editable ? 'Edits are validated before they reach the bundle.' : 'This object is not editable.'}</div>
          </div>
        )}
      </div>
    </section>
  );
}

function Workspace({ session, onNew, onRepack, repacking, onNotice, notice, onDismiss }: { session: SessionData; onNew: () => void; onRepack: () => void; repacking: boolean; onNotice: (text: string) => void; notice: Notice; onDismiss: () => void }) {
  const [search, setSearch] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showUnreadable, setShowUnreadable] = useState(true);
  const [dirtyOnly, setDirtyOnly] = useState(false);
  const [classFilter, setClassFilter] = useState('');
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(readSavedSearches);
  const [showReplace, setShowReplace] = useState(false);
  const [replaceFind, setReplaceFind] = useState('');
  const [replaceWith, setReplaceWith] = useState('');
  const [replaceCaseSensitive, setReplaceCaseSensitive] = useState(false);
  const [replacePreview, setReplacePreview] = useState<{ matched_count: number; changed_count?: number; failed?: { path_id: string; error: string }[] } | null>(null);
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [comparison, setComparison] = useState<BundleComparison | null>(null);
  const [comparisonBusy, setComparisonBusy] = useState(false);
  const [comparisonDiff, setComparisonDiff] = useState<{ pathId: string; changes: ReturnType<typeof diffJson>; error?: string } | null>(null);
  const [baselineJsonByPath, setBaselineJsonByPath] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<AssetRecord | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<AssetRecord[]>(session.objects);
  const [tab, setTab] = useState<Tab>('inspect');
  const [editorState, setEditorState] = useState<'idle' | 'valid' | 'invalid' | 'saved'>('idle');
  const [sortKey, setSortKey] = useState<SortKey>('size');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const detailRequestId = useRef(0);
  const storageWarningShown = useRef(false);
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const compareFileInput = useRef<HTMLInputElement>(null);

  const selectRecord = async (record: AssetRecord) => {
    const requestId = detailRequestId.current + 1;
    detailRequestId.current = requestId;
    undoStack.current = [];
    redoStack.current = [];
    setStoredValue(`${SELECTED_OBJECT_KEY}${session.session_id}`, String(record.path_id));
    setSelected(record); setDetail(null); setLoading(true); setEditorState('idle'); setTab('inspect');
    try {
      const response = await fetch(apiUrl(`/unity-api/session/${encodeURIComponent(session.session_id)}/object/${encodeURIComponent(String(record.path_id))}`));
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Could not load this object.'));
      const data = await response.json() as DetailResponse;
      if (requestId !== detailRequestId.current) return;
      const pathKey = String(data.path_id);
      const original = data.json ? JSON.stringify(data.json, null, 2) : '';
      setBaselineJsonByPath((current) => current[pathKey] !== undefined ? current : { ...current, [pathKey]: original });
      setDetail(data);
      const savedDraft = getStoredValue(draftStorageKey(session.session_id, String(record.path_id)));
      setJsonText(savedDraft ?? original);
    } catch (error) {
      if (requestId !== detailRequestId.current) return;
      onNotice(error instanceof Error ? error.message : 'Could not load this object.');
      setJsonText('');
    } finally {
      if (requestId === detailRequestId.current) setLoading(false);
    }
  };
  useEffect(() => {
    const savedPathId = getStoredValue(`${SELECTED_OBJECT_KEY}${session.session_id}`);
    if (!savedPathId) return;
    const savedRecord = session.objects.find((record) => String(record.path_id) === savedPathId);
    if (savedRecord) void selectRecord(savedRecord);
    else removeStoredValue(`${SELECTED_OBJECT_KEY}${session.session_id}`);
  }, [session.session_id]);
  const sortBy = (key: SortKey) => {
    if (sortKey === key) setDirection((current) => current === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setDirection('asc'); }
  };
  const validate = () => {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('The root must be a JSON object for a MonoBehaviour type tree.');
      }
      setEditorState('valid');
      onNotice('JSON is valid and ready to save.');
    } catch (error) {
      setEditorState('invalid');
      onNotice(error instanceof Error && error.message.startsWith('The root')
        ? error.message
        : 'Invalid JSON. Check commas, quotes, and brackets before saving.');
    }
  };
  const save = async () => {
    if (!selected || !selected.editable) return;
    const targetPathId = String(selected.path_id);
    const requestVersion = detailRequestId.current;
    let parsed: unknown;
    try { parsed = JSON.parse(jsonText); } catch { setEditorState('invalid'); onNotice('Invalid JSON. Fix the payload before saving.'); return; }
    setSaving(true);
    try {
      const response = await fetch(apiUrl(`/unity-api/session/${encodeURIComponent(session.session_id)}/object/${encodeURIComponent(targetPathId)}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: parsed }) });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'The object could not be saved.'));
      const data = await response.json() as DetailResponse;
      setRows((current) => current.map((row) => row.path_id === data.path_id ? { ...row, ...data } : row));
      removeStoredValue(draftStorageKey(session.session_id, String(data.path_id)));
      if (requestVersion === detailRequestId.current && String(selected.path_id) === String(data.path_id)) {
        setDetail(data);
        setSelected((current) => current?.path_id === data.path_id ? { ...current, ...data } : current);
        setJsonText(data.json ? JSON.stringify(data.json, null, 2) : '');
        setEditorState('saved');
      }
      onNotice(`PathID ${targetPathId} saved to the active session.`);
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Could not save this object.'); }
    finally { setSaving(false); }
  };
  const changeJsonDraft = (value: string) => {
    if (value !== jsonText) {
      undoStack.current = [...undoStack.current.slice(-99), jsonText];
      redoStack.current = [];
    }
    setJsonText(value);
    if (editorState !== 'idle') setEditorState('idle');
    if (!selected) return;
    const saved = setStoredValue(draftStorageKey(session.session_id, String(selected.path_id)), value);
    if (!saved && !storageWarningShown.current) {
      storageWarningShown.current = true;
      onNotice('This browser cannot keep an unsaved draft after a page reload. Save changes to the active session.');
    }
  };
  const undo = () => {
    const previous = undoStack.current.pop();
    if (previous === undefined) return;
    redoStack.current.push(jsonText);
    setJsonText(previous);
    setStoredValue(draftStorageKey(session.session_id, String(selected?.path_id)), previous);
    setEditorState('idle');
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (next === undefined) return;
    undoStack.current.push(jsonText);
    setJsonText(next);
    setStoredValue(draftStorageKey(session.session_id, String(selected?.path_id)), next);
    setEditorState('idle');
  };
  const saveSearch = () => {
    const name = window.prompt('Name this saved search', search.trim() || 'New search');
    if (!name?.trim()) return;
    const next = [...savedSearches.filter((item) => item.name !== name.trim()), {
      name: name.trim(),
      query: search,
      className: classFilter,
      dirtyOnly,
    }];
    setSavedSearches(next);
    try { window.localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(next)); }
    catch { onNotice('This browser could not save the search preset.'); }
  };
  const applySavedSearch = (name: string) => {
    const preset = savedSearches.find((item) => item.name === name);
    if (!preset) return;
    setSearch(preset.query);
    setClassFilter(preset.className || '');
    setDirtyOnly(Boolean(preset.dirtyOnly));
  };
  const exportAudit = () => {
    const names = new Map<string, string[]>();
    for (const row of rows) {
      const key = objectName(row).trim().toLocaleLowerCase();
      if (!key) continue;
      names.set(key, [...(names.get(key) || []), String(row.path_id)]);
    }
    const duplicateNames = [...names.entries()].filter(([, pathIds]) => pathIds.length > 1).map(([name, pathIds]) => ({ name, path_ids: pathIds }));
    downloadJsonFile(`${session.file_name}.xenon-report.json`, {
      generated_at: new Date().toISOString(),
      file: { name: session.file_name, size: session.file_size },
      summary: {
        total_objects: rows.length,
        edited_objects: rows.filter((row) => row.dirty).length,
        unreadable_objects: rows.filter((row) => !row.editable).length,
        duplicate_names: duplicateNames.length,
      },
      duplicate_names: duplicateNames,
      unreadable_objects: rows.filter((row) => !row.editable).map((row) => ({ path_id: row.path_id, name: objectName(row), type: row.class_name, reason: row.parse_error })),
      edited_objects: rows.filter((row) => row.dirty).map((row) => ({ path_id: row.path_id, name: objectName(row), type: row.class_name })),
    });
    onNotice('Inspection report exported as JSON.');
  };
  const submitBatchReplace = async (previewOnly: boolean) => {
    if (!replaceFind) return;
    setReplaceBusy(true);
    try {
      const response = await fetch(apiUrl(`/unity-api/session/${encodeURIComponent(session.session_id)}/batch-replace`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ find: replaceFind, replace: replaceWith, case_sensitive: replaceCaseSensitive, preview: previewOnly }),
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Batch replace failed.'));
      const result = await response.json() as { matched_count: number; changed_count?: number; failed?: { path_id: string; error: string }[]; objects?: AssetRecord[] };
      setReplacePreview(result);
      if (!previewOnly) {
        if (result.objects?.length) {
          const changed = new Map(result.objects.map((item) => [String(item.path_id), item]));
          setRows((current) => current.map((item) => changed.get(String(item.path_id)) || item));
        }
        if (selected && result.objects?.some((item) => String(item.path_id) === String(selected.path_id))) {
          const updated = result.objects.find((item) => String(item.path_id) === String(selected.path_id));
          if (updated) void selectRecord(updated);
        }
        onNotice(`Batch replace updated ${result.changed_count || 0} object${result.changed_count === 1 ? '' : 's'}.${result.failed?.length ? ` ${result.failed.length} object(s) could not be updated.` : ''}`);
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Batch replace failed.');
    } finally { setReplaceBusy(false); }
  };
  const compareBundle = async (file?: File) => {
    if (!file) return;
    setComparisonBusy(true);
    setComparisonDiff(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch(apiUrl('/unity-api/upload'), { method: 'POST', body });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'The comparison bundle could not be opened.'));
      const other = await response.json() as SessionData;
      const currentByPath = new Map(rows.map((row) => [String(row.path_id), row]));
      const otherByPath = new Map(other.objects.map((row) => [String(row.path_id), row]));
      const entries: ComparisonEntry[] = [];
      let unchanged = 0;
      for (const [pathId, after] of otherByPath) {
        const before = currentByPath.get(pathId);
        if (!before) entries.push({ path_id: pathId, after, kind: 'added' });
        else if (before.name !== after.name || before.class_name !== after.class_name || before.size !== after.size) {
          entries.push({ path_id: pathId, before, after, kind: 'changed' });
        } else unchanged += 1;
      }
      for (const [pathId, before] of currentByPath) {
        if (!otherByPath.has(pathId)) entries.push({ path_id: pathId, before, kind: 'removed' });
      }
      entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.path_id.localeCompare(b.path_id, undefined, { numeric: true }));
      setComparison({ session_id: other.session_id, file_name: other.file_name, entries, unchanged });
      onNotice(`Compared ${session.file_name} with ${other.file_name}. Inventory compares PathID, name, type, and serialized size.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Bundle comparison failed.');
    } finally {
      setComparisonBusy(false);
      if (compareFileInput.current) compareFileInput.current.value = '';
    }
  };
  const compareObjectDetails = async (entry: ComparisonEntry) => {
    if (!comparison || !entry.before || !entry.after) return;
    setComparisonDiff({ pathId: entry.path_id, changes: [] });
    try {
      const [beforeResponse, afterResponse] = await Promise.all([
        fetch(apiUrl(`/unity-api/session/${encodeURIComponent(session.session_id)}/object/${encodeURIComponent(entry.path_id)}`)),
        fetch(apiUrl(`/unity-api/session/${encodeURIComponent(comparison.session_id)}/object/${encodeURIComponent(entry.path_id)}`)),
      ]);
      if (!beforeResponse.ok || !afterResponse.ok) throw new Error('The serialized data for this PathID is not available in both bundles.');
      const [before, after] = await Promise.all([beforeResponse.json(), afterResponse.json()]) as [DetailResponse, DetailResponse];
      setComparisonDiff({ pathId: entry.path_id, changes: diffJson(before.json, after.json) });
    } catch (error) {
      setComparisonDiff({ pathId: entry.path_id, changes: [], error: error instanceof Error ? error.message : 'Could not compare this object.' });
    }
  };
  const closeSelected = () => {
    detailRequestId.current += 1;
    setSelected(null);
    setDetail(null);
    setLoading(false);
    removeStoredValue(`${SELECTED_OBJECT_KEY}${session.session_id}`);
  };
  const treeValue = parseTreeValue(jsonText);
  const cycleSort = (key: SortKey) => sortBy(key);
  const classNames = Array.isArray(session.classes) ? session.classes : Object.keys(session.classes || {});
  return (
    <div className="inspector-shell">
      <div className="editor-wrap">
        <AppHeader fileName={session.file_name} onNew={onNew} onRepack={onRepack} repacking={repacking} />
        <div className="search-row">
          <label className="search-box"><Search size={18} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search names, fields, values, or PathIDs" data-testid="input-object-search" /></label>
          <div className="search-options">
            <button type="button" className={`search-option ${caseSensitive ? 'active' : ''}`} title="Case sensitive search" aria-label="Toggle case sensitive search" onClick={() => setCaseSensitive((current) => !current)}>*</button>
            <button type="button" className="search-option" title="Search options" aria-label="Search options" onClick={() => setOptionsOpen((current) => !current)}><SlidersHorizontal size={16} /></button>
          </div>
          <div className="saved-search-actions">
            <button type="button" className="small-button" onClick={saveSearch} title="Save this search"><BookmarkPlus size={14} /> Save search</button>
            <select aria-label="Saved searches" value="" onChange={(event) => applySavedSearch(event.target.value)}>
              <option value="">Saved searches…</option>
              {savedSearches.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}
            </select>
          </div>
          <div className="workspace-tools">
            <input ref={compareFileInput} type="file" className="sr-only" onChange={(event) => void compareBundle(event.target.files?.[0])} aria-label="Choose bundle to compare" />
            <button type="button" className="small-button" onClick={() => compareFileInput.current?.click()} disabled={comparisonBusy}><GitCompare size={14} /> {comparisonBusy ? 'Comparing…' : 'Compare bundle'}</button>
            <button type="button" className="small-button" onClick={() => { setShowReplace((current) => !current); setReplacePreview(null); }}><Replace size={14} /> Batch replace</button>
            <button type="button" className="small-button" onClick={exportAudit}><FileText size={14} /> Export report</button>
          </div>
          {optionsOpen && <div className="menu-popover search-filter-popover">
            <label><input type="checkbox" checked={showUnreadable} onChange={(event) => setShowUnreadable(event.target.checked)} /> Show unreadable objects</label>
            <label><input type="checkbox" checked={dirtyOnly} onChange={(event) => setDirtyOnly(event.target.checked)} /> Edited objects only</label>
            <label>Type
              <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)}>
                <option value="">All types</option>
                {classNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => { setSearch(''); setClassFilter(''); setDirtyOnly(false); setShowUnreadable(true); setOptionsOpen(false); }}>Reset filters</button>
          </div>}
        </div>
        {showReplace && <section className="batch-replace-panel" aria-label="Batch replace string values">
          <div className="batch-replace-heading"><div><strong>Batch replace serialized strings</strong><span>Preview first. Replaces string values in editable MonoBehaviour objects, not field names.</span></div><button type="button" className="small-button" onClick={() => setShowReplace(false)} aria-label="Close batch replace"><X size={14}/></button></div>
          <div className="batch-replace-form">
            <label>Find<input value={replaceFind} onChange={(event) => { setReplaceFind(event.target.value); setReplacePreview(null); }} placeholder="Text to find" /></label>
            <label>Replace with<input value={replaceWith} onChange={(event) => { setReplaceWith(event.target.value); setReplacePreview(null); }} placeholder="Replacement text" /></label>
            <label className="replace-case"><input type="checkbox" checked={replaceCaseSensitive} onChange={(event) => setReplaceCaseSensitive(event.target.checked)} /> Case sensitive</label>
            <button type="button" className="small-button" disabled={replaceBusy || !replaceFind} onClick={() => void submitBatchReplace(true)}>{replaceBusy ? <Loader2 size={14} className="animate-spin"/> : <Search size={14}/>} Preview</button>
            <button type="button" className="small-button primary" disabled={replaceBusy || !replaceFind || !replacePreview?.matched_count} onClick={() => void submitBatchReplace(false)}><Check size={14}/> Apply to {replacePreview?.matched_count || 0}</button>
          </div>
          {replacePreview && <div className="replace-result" role="status">{replacePreview.changed_count === undefined ? `${replacePreview.matched_count} matching value${replacePreview.matched_count === 1 ? '' : 's'} found across editable objects.` : `Updated ${replacePreview.changed_count} object${replacePreview.changed_count === 1 ? '' : 's'}; ${replacePreview.failed?.length || 0} object(s) failed.`}</div>}
        </section>}
        {comparison && <section className="comparison-panel" aria-label="Bundle comparison results">
          <div className="comparison-heading"><div><span className="eyebrow">INVENTORY COMPARISON</span><h2>{session.file_name} <span>vs</span> {comparison.file_name}</h2><p>Matches by PathID. Metadata comparison includes name, class, and serialized size; open a changed object for a serialized JSON diff.</p></div><button type="button" className="small-button" onClick={() => { setComparison(null); setComparisonDiff(null); }} aria-label="Close comparison"><X size={14}/></button></div>
          <div className="comparison-counts">
            <span><b>{comparison.entries.filter((entry) => entry.kind === 'added').length}</b> added</span>
            <span><b>{comparison.entries.filter((entry) => entry.kind === 'removed').length}</b> removed</span>
            <span><b>{comparison.entries.filter((entry) => entry.kind === 'changed').length}</b> metadata changed</span>
            <span><b>{comparison.unchanged}</b> unchanged</span>
          </div>
          {comparison.entries.length > 0 && <div className="comparison-list">{comparison.entries.slice(0, 80).map((entry) => {
            const row = entry.after || entry.before;
            return <article className="comparison-row" key={`${entry.kind}:${entry.path_id}`}>
              <span className={`comparison-kind ${entry.kind}`}>{entry.kind}</span>
              <code>{entry.path_id}</code><span className="comparison-object-name">{row ? objectName(row) : ''}</span>
              <span className="comparison-object-class">{row ? objectClass(row) : ''}</span>
              {entry.kind === 'changed' && <button type="button" className="small-button" onClick={() => void compareObjectDetails(entry)}>Diff fields</button>}
            </article>;
          })}{comparison.entries.length > 80 && <p className="comparison-overflow">Showing the first 80 of {comparison.entries.length} inventory differences.</p>}</div>}
          {comparisonDiff && <div className="comparison-detail-diff">
            <div className="comparison-diff-head"><strong>Serialized JSON · PathID {comparisonDiff.pathId}</strong><button type="button" className="small-button" onClick={() => setComparisonDiff(null)} aria-label="Close serialized diff"><X size={13}/></button></div>
            {comparisonDiff.error ? <p className="comparison-diff-error">{comparisonDiff.error}</p> : comparisonDiff.changes.length ? comparisonDiff.changes.map((change) => <div className="diff-item" key={change.path}><code>{change.path}</code><div className="diff-values"><pre className="diff-before">− {displayDiffValue(change.before)}</pre><pre className="diff-after">+ {displayDiffValue(change.after)}</pre></div></div>) : <p className="comparison-overflow">No JSON field differences were found; the metadata changed.</p>}
          </div>}
          {!comparison.entries.length && <div className="diff-empty"><Check size={19}/> No PathID, name, type, or size differences in the indexed MonoBehaviour objects.</div>}
        </section>}
        <div className="content-grid">
          <aside className="asset-pane" aria-label="Asset table">
            <AssetTable objects={rows} totalObjects={session.total_objects} selectedId={selected ? selected.path_id : null} onSelect={selectRecord} search={search} caseSensitive={caseSensitive} showUnreadable={showUnreadable} dirtyOnly={dirtyOnly} classFilter={classFilter} sortKey={sortKey} direction={direction} onSort={cycleSort} />
          </aside>
          <DetailPane record={selected} detail={detail} loading={loading} tab={tab} setTab={setTab} jsonText={jsonText} originalJsonText={selected ? baselineJsonByPath[String(selected.path_id)] ?? '' : ''} setJsonText={changeJsonDraft} treeValue={treeValue} onTreeChange={(value) => changeJsonDraft(JSON.stringify(value, null, 2))} editorState={editorState} onValidate={validate} onSave={save} onUndo={undo} onRedo={redo} canUndo={undoStack.current.length > 0} canRedo={redoStack.current.length > 0} saving={saving} onClose={closeSelected} objects={rows} onNavigate={selectRecord} />
        </div>
      </div>
      <StatusBanner notice={notice} onDismiss={onDismiss} />
    </div>
  );
}

function Home() {
  const [session, setSession] = useState<SessionData | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [uploading, setUploading] = useState(false);
  const [repacking, setRepacking] = useState(false);
  const [restoringSession, setRestoringSession] = useState(() => Boolean(getStoredValue(ACTIVE_SESSION_KEY)));

  useEffect(() => {
    const sessionId = getStoredValue(ACTIVE_SESSION_KEY);
    if (!sessionId) {
      setRestoringSession(false);
      return;
    }

    let active = true;
    const restoreSession = async () => {
      try {
        const response = await fetch(apiUrl(`/unity-api/session/${encodeURIComponent(sessionId)}`));
        if (response.status === 404) {
          removeStoredValue(ACTIVE_SESSION_KEY);
          removeStoredValue(`${SELECTED_OBJECT_KEY}${sessionId}`);
          clearSessionDrafts(sessionId);
          if (active) setNotice({ tone: 'info', text: 'The previous inspection expired. Open the bundle again to continue.' });
          return;
        }
        if (!response.ok) throw new Error(await apiErrorMessage(response, 'The previous inspection could not be restored.'));
        const restored = await response.json() as SessionData;
        if (active) {
          setSession(restored);
          setNotice({ tone: 'info', text: `${restored.file_name} restored in this tab.` });
        }
      } catch (error) {
        if (active) setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'The previous inspection could not be restored.' });
      } finally {
        if (active) setRestoringSession(false);
      }
    };
    void restoreSession();
    return () => { active = false; };
  }, []);

  const reset = () => {
    if (session) {
      removeStoredValue(`${SELECTED_OBJECT_KEY}${session.session_id}`);
      clearSessionDrafts(session.session_id);
    }
    removeStoredValue(ACTIVE_SESSION_KEY);
    setSession(null);
    setNotice(null);
  };
  const upload = async (file: File) => {
    setUploading(true); setNotice(null);
    try {
      const body = new FormData(); body.append('file', file);
      const response = await fetch(apiUrl('/unity-api/upload'), { method: 'POST', body });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'The file could not be uploaded.'));
      const data = await response.json() as SessionData;
      const previousSessionId = getStoredValue(ACTIVE_SESSION_KEY);
      if (previousSessionId && previousSessionId !== data.session_id) {
        clearSessionDrafts(previousSessionId);
        removeStoredValue(`${SELECTED_OBJECT_KEY}${previousSessionId}`);
      }
      const sessionStored = setStoredValue(ACTIVE_SESSION_KEY, data.session_id);
      setSession(data);
      setNotice({
        tone: 'success',
        text: `${data.file_name} opened. ${data.total_objects || data.objects.length} objects are ready.${sessionStored ? '' : ' This browser cannot restore it after a page reload, so save your edits before leaving.'}`,
      });
    } catch (error) { setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'The file could not be read.' }); }
    finally { setUploading(false); }
  };
  const repack = async () => {
    if (!session) return;
    setRepacking(true); setNotice(null);
    try {
      const response = await fetch(apiUrl(`/unity-api/session/${encodeURIComponent(session.session_id)}/repack`), { method: 'POST' });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'The bundle could not be repacked.'));
      const result = await response.json() as { download_url?: string; file_name?: string };
      const downloadPath = result.download_url || `/unity-api/session/${encodeURIComponent(session.session_id)}/download`;
      const anchor = document.createElement('a'); anchor.href = apiUrl(downloadPath); anchor.download = result.file_name || `repacked-${session.file_name}`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setNotice({ tone: 'success', text: `${result.file_name || 'Repacked file'} is ready. Download started.` });
    } catch (error) { setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Could not repack this file.' }); }
    finally { setRepacking(false); }
  };

  if (restoringSession && !session) {
    return <div className="inspector-shell"><div className="editor-wrap"><AppHeader onNew={() => setNotice({ tone: 'info', text: 'Restoring the previous inspection…' })} /><div className="restore-loading"><Loader2 size={24} className="animate-spin" /><span>Restoring your open bundle…</span></div></div><StatusBanner notice={notice} onDismiss={() => setNotice(null)} /></div>;
  }
  if (!session) return <div className="inspector-shell"><div className="editor-wrap"><AppHeader onNew={() => setNotice({ tone: 'info', text: 'Choose a file below to start a new inspection.' })} /><EmptyWorkspace onFile={upload} busy={uploading} /></div><StatusBanner notice={notice} onDismiss={() => setNotice(null)} /></div>;
  return <Workspace session={session} onNew={reset} onRepack={repack} repacking={repacking} onNotice={(text) => setNotice({ tone: 'info', text })} notice={notice} onDismiss={() => setNotice(null)} />;
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;