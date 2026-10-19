import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Maximize2,
  Minimize2,
  Plus,
  Redo2,
  Save,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';

export type TreeJsonValue =
  | string
  | number
  | boolean
  | null
  | TreeJsonValue[]
  | { [key: string]: TreeJsonValue };

type PathSegment = string | number;
type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

type TreeEditorProps = {
  value: TreeJsonValue;
  rootName: string;
  saving: boolean;
  editorState: 'idle' | 'valid' | 'invalid' | 'saved';
  onChange: (value: TreeJsonValue) => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};

const isJsonObject = (value: TreeJsonValue): value is { [key: string]: TreeJsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const valueType = (value: TreeJsonValue): ValueType => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value as 'string' | 'number' | 'boolean';
};

function valueForType(type: ValueType): TreeJsonValue {
  if (type === 'string') return '';
  if (type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'object') return {};
  if (type === 'array') return [];
  return null;
}

function getEntries(value: TreeJsonValue): [PathSegment, TreeJsonValue][] {
  if (Array.isArray(value)) return value.map((entry, index) => [index, entry]);
  if (isJsonObject(value)) return Object.entries(value);
  return [];
}

function getAtPath(root: TreeJsonValue, path: PathSegment[]): TreeJsonValue {
  return path.reduce<TreeJsonValue>((current, segment) => {
    if (Array.isArray(current) && typeof segment === 'number') return current[segment] ?? null;
    if (isJsonObject(current) && typeof segment === 'string') return current[segment] ?? null;
    return null;
  }, root);
}

function updateAtPath(
  root: TreeJsonValue,
  path: PathSegment[],
  transform: (value: TreeJsonValue) => TreeJsonValue,
): TreeJsonValue {
  if (path.length === 0) return transform(root);
  const [segment, ...rest] = path;

  if (Array.isArray(root) && typeof segment === 'number') {
    return root.map((entry, index) => index === segment ? updateAtPath(entry, rest, transform) : entry);
  }
  if (isJsonObject(root) && typeof segment === 'string' && segment in root) {
    return { ...root, [segment]: updateAtPath(root[segment], rest, transform) };
  }
  return root;
}

function removeAtPath(root: TreeJsonValue, path: PathSegment[]): TreeJsonValue {
  if (path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const segment = path[path.length - 1];
  const parent = getAtPath(root, parentPath);

  if (Array.isArray(parent) && typeof segment === 'number') {
    return updateAtPath(root, parentPath, () => parent.filter((_, index) => index !== segment));
  }
  if (isJsonObject(parent) && typeof segment === 'string') {
    const next = { ...parent };
    delete next[segment];
    return updateAtPath(root, parentPath, () => next);
  }
  return root;
}

function renameAtPath(root: TreeJsonValue, path: PathSegment[], nextKey: string): TreeJsonValue | null {
  if (!path.length || typeof path[path.length - 1] !== 'string') return null;
  const oldKey = path[path.length - 1] as string;
  const parentPath = path.slice(0, -1);
  const parent = getAtPath(root, parentPath);
  const trimmedKey = nextKey.trim();
  if (!isJsonObject(parent) || !trimmedKey || (trimmedKey !== oldKey && trimmedKey in parent)) return null;

  const next = { ...parent, [trimmedKey]: parent[oldKey] };
  if (trimmedKey !== oldKey) delete next[oldKey];
  return updateAtPath(root, parentPath, () => next);
}

function buildSearchIndex(rootName: string, rootValue: TreeJsonValue, query: string) {
  const paths = new Set<string>();
  const matchPaths: string[] = [];
  let matchCount = 0;
  const normalized = query.toLocaleLowerCase();

  const visit = (label: string, value: TreeJsonValue, path: PathSegment[]): boolean => {
    const ownValue = value === null ? 'null' : typeof value === 'object' ? '' : String(value);
    const ownMatch = label.toLocaleLowerCase().includes(normalized) || ownValue.toLocaleLowerCase().includes(normalized);
    let childMatch = false;
    for (const [key, child] of getEntries(value)) {
      if (visit(String(key), child, [...path, key])) childMatch = true;
    }
    if (ownMatch) {
      matchCount += 1;
      matchPaths.push(JSON.stringify(path));
    }
    if (ownMatch || childMatch) paths.add(JSON.stringify(path));
    return ownMatch || childMatch;
  };

  if (query) visit(rootName, rootValue, []);
  return { paths, matchCount, matchPaths };
}

function displayPath(path: PathSegment[]) {
  return `$${path.map((segment) => typeof segment === 'number' ? `[${segment}]` : `[${JSON.stringify(segment)}]`).join('')}`;
}

function TreeNodeEditor({
  label,
  path,
  value,
  depth,
  query,
  searchPaths,
  expandedPaths,
  saving,
  onToggle,
  onValueChange,
  onRename,
  onRemove,
  onAdd,
}: {
  label: string;
  path: PathSegment[];
  value: TreeJsonValue;
  depth: number;
  query: string;
  searchPaths: Set<string>;
  expandedPaths: Set<string>;
  saving: boolean;
  onToggle: (path: PathSegment[]) => void;
  onValueChange: (path: PathSegment[], nextValue: TreeJsonValue) => void;
  onRename: (path: PathSegment[], nextKey: string) => boolean;
  onRemove: (path: PathSegment[]) => void;
  onAdd: (path: PathSegment[]) => void;
}) {
  const [keyDraft, setKeyDraft] = useState(label);
  const [renameError, setRenameError] = useState(false);
  const [numberDraft, setNumberDraft] = useState(typeof value === 'number' ? String(value) : '');
  const pathKey = JSON.stringify(path);
  const entries = getEntries(value);
  const visibleEntries = query
    ? entries.filter(([key]) => searchPaths.has(JSON.stringify([...path, key])))
    : entries;
  const isContainer = Array.isArray(value) || isJsonObject(value);
  const isExpanded = query ? visibleEntries.length > 0 : expandedPaths.has(pathKey);
  const isRoot = path.length === 0;
  const type = valueType(value);

  useEffect(() => {
    setKeyDraft(label);
    setRenameError(false);
  }, [label]);
  useEffect(() => {
    setNumberDraft(typeof value === 'number' ? String(value) : '');
  }, [value]);

  if (query && !searchPaths.has(pathKey)) return null;

  const changeType = (nextType: ValueType) => onValueChange(path, valueForType(nextType));
  const commitKey = () => {
    if (keyDraft === label) return;
    const renamed = onRename(path, keyDraft);
    setRenameError(!renamed);
    if (!renamed) setKeyDraft(label);
  };

  return (
    <div className="tree-node">
      <div
        className={`tree-editor-row ${isRoot ? 'root-row' : ''}`}
        data-tree-path={pathKey}
        style={{
          '--tree-indent': `${Math.min(depth, 4) * 16}px`,
          '--tree-indent-mobile': `${Math.min(depth, 3) * 12}px`,
        } as CSSProperties}
      >
        {isContainer ? (
          <button
            type="button"
            className="tree-toggle"
            aria-label={isExpanded ? `Collapse ${label}` : `Expand ${label}`}
            onClick={() => onToggle(path)}
          >
            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : <span className="tree-spacer" />}

        {isRoot ? (
          <span className="tree-editor-key root-key">{label}</span>
        ) : typeof path[path.length - 1] === 'string' ? (
          <span className="tree-key-wrap">
            <input
              className={`tree-editor-key tree-key-input ${renameError ? 'invalid' : ''}`}
              aria-label={`Field name for ${label}`}
              value={keyDraft}
              disabled={saving}
              onChange={(event) => { setKeyDraft(event.target.value); setRenameError(false); }}
              onBlur={commitKey}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
              spellCheck={false}
            />
            {renameError && <span className="tree-key-error">Use a unique, non-empty key</span>}
          </span>
        ) : (
          <span className="tree-editor-key array-index">{label}</span>
        )}
        {!isRoot && <span className="tree-separator">:</span>}

        {isContainer ? (
          <span className="tree-container-value">
            {Array.isArray(value) ? `Array · ${value.length} items` : `Object · ${entries.length} fields`}
          </span>
        ) : type === 'string' ? (
          <input
            className="tree-value-input string-value"
            aria-label={`Value for ${label}`}
            value={value as string}
            disabled={saving}
            onChange={(event) => onValueChange(path, event.target.value)}
            spellCheck={false}
          />
        ) : type === 'number' ? (
          <input
            className="tree-value-input number-value"
            aria-label={`Value for ${label}`}
            type="text"
            inputMode="decimal"
            value={numberDraft}
            disabled={saving}
            onChange={(event) => {
              const nextDraft = event.target.value;
              setNumberDraft(nextDraft);
              if (nextDraft.trim() && Number.isFinite(Number(nextDraft))) onValueChange(path, Number(nextDraft));
            }}
            onBlur={() => {
              if (!numberDraft.trim() || !Number.isFinite(Number(numberDraft))) {
                setNumberDraft(String(value as number));
              }
            }}
            spellCheck={false}
          />
        ) : type === 'boolean' ? (
          <label className="tree-boolean-control">
            <input
              type="checkbox"
              aria-label={`Value for ${label}`}
              checked={value as boolean}
              disabled={saving}
              onChange={(event) => onValueChange(path, event.target.checked)}
            />
            <span>{value ? 'true' : 'false'}</span>
          </label>
        ) : (
          <span className="tree-container-value">null</span>
        )}

        {!isRoot && (
          <select
            className="tree-value-type"
            aria-label={`Change type of ${label}`}
            value={type}
            disabled={saving}
            onChange={(event) => changeType(event.target.value as ValueType)}
          >
            <option value="string">Text</option>
            <option value="number">Number</option>
            <option value="boolean">Boolean</option>
            <option value="null">Null</option>
            <option value="object">Object</option>
            <option value="array">Array</option>
          </select>
        )}

        <div className="tree-row-actions">
          {isContainer && (
            <button
              type="button"
              className="tree-icon-button"
              aria-label={Array.isArray(value) ? `Add item to ${label}` : `Add field to ${label}`}
              title={Array.isArray(value) ? 'Add item' : 'Add field'}
              disabled={saving}
              onClick={() => onAdd(path)}
            >
              <Plus size={15} />
            </button>
          )}
          {!isRoot && (
            <button
              type="button"
              className="tree-icon-button danger"
              aria-label={`Remove ${label}`}
              title="Remove field"
              disabled={saving}
              onClick={() => onRemove(path)}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {isExpanded && visibleEntries.map(([childKey, childValue]) => {
        const childPath = [...path, childKey];
        return (
          <TreeNodeEditor
            key={JSON.stringify(childPath)}
            label={String(childKey)}
            path={childPath}
            value={childValue}
            depth={depth + 1}
            query={query}
            searchPaths={searchPaths}
            expandedPaths={expandedPaths}
            saving={saving}
            onToggle={onToggle}
            onValueChange={onValueChange}
            onRename={onRename}
            onRemove={onRemove}
            onAdd={onAdd}
          />
        );
      })}
    </div>
  );
}

export function TreeEditor({
  value,
  rootName,
  saving,
  editorState,
  onChange,
  onSave,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: TreeEditorProps) {
  const [query, setQuery] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(['[]']));
  const [activeMatch, setActiveMatch] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const normalizedQuery = query.trim();
  const searchIndex = useMemo(
    () => buildSearchIndex(rootName, value, normalizedQuery),
    [rootName, value, normalizedQuery],
  );

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [isFullscreen]);

  const togglePath = (path: PathSegment[]) => {
    const key = JSON.stringify(path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allContainerPaths = useMemo(() => {
    const paths: string[] = [];
    const visit = (node: TreeJsonValue, path: PathSegment[]) => {
      if (!Array.isArray(node) && !isJsonObject(node)) return;
      paths.push(JSON.stringify(path));
      for (const [key, child] of getEntries(node)) visit(child, [...path, key]);
    };
    visit(value, []);
    return paths;
  }, [value]);

  useEffect(() => {
    setActiveMatch(0);
  }, [normalizedQuery]);

  const moveToMatch = (direction: -1 | 1) => {
    const paths = searchIndex.matchPaths;
    if (!paths.length) return;
    const nextIndex = (activeMatch + direction + paths.length) % paths.length;
    setActiveMatch(nextIndex);
    const targetPath = paths[nextIndex];
    window.requestAnimationFrame(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>('[data-tree-path]'))
        .find((element) => element.dataset.treePath === targetPath);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.classList.add('tree-match-active');
      window.setTimeout(() => target?.classList.remove('tree-match-active'), 1000);
    });
  };

  const copyActivePath = async () => {
    const serialized = searchIndex.matchPaths[activeMatch] ?? '[]';
    const path = displayPath(JSON.parse(serialized) as PathSegment[]);
    try {
      await navigator.clipboard.writeText(path);
      setCopyStatus('Path copied');
      window.setTimeout(() => setCopyStatus(''), 1400);
    } catch {
      setCopyStatus('Clipboard unavailable');
      window.setTimeout(() => setCopyStatus(''), 1800);
    }
  };

  const updateValue = (path: PathSegment[], nextValue: TreeJsonValue) => {
    onChange(updateAtPath(value, path, () => nextValue));
  };

  const renameKey = (path: PathSegment[], nextKey: string) => {
    const next = renameAtPath(value, path, nextKey);
    if (!next) return false;
    onChange(next);
    return true;
  };

  const addChild = (path: PathSegment[]) => {
    const parent = getAtPath(value, path);
    if (Array.isArray(parent)) {
      onChange(updateAtPath(value, path, () => [...parent, null]));
    } else if (isJsonObject(parent)) {
      let key = 'newField';
      let suffix = 2;
      while (key in parent) key = `newField${suffix++}`;
      onChange(updateAtPath(value, path, () => ({ ...parent, [key]: '' })));
      setExpandedPaths((current) => new Set([...current, JSON.stringify(path)]));
    }
    setQuery('');
  };

  const saveLabel = saving
    ? 'Saving…'
    : editorState === 'saved'
      ? 'Saved'
      : 'Save changes';

  return (
    <section className={`tree-editor ${isFullscreen ? 'is-fullscreen' : ''}`} aria-label="Editable object tree">
      <div className="tree-editor-toolbar">
        <div className="tree-editor-heading">
          <span className="tree-editor-kicker">SERIALIZED OBJECT</span>
          <strong>{rootName}</strong>
        </div>
        <div className="tree-editor-toolbar-actions">
          <button type="button" className="tree-toolbar-button" onClick={onUndo} disabled={!canUndo || saving} aria-label="Undo tree edit" title="Undo">
            <Undo2 size={15} /><span>Undo</span>
          </button>
          <button type="button" className="tree-toolbar-button" onClick={onRedo} disabled={!canRedo || saving} aria-label="Redo tree edit" title="Redo">
            <Redo2 size={15} /><span>Redo</span>
          </button>
          <button
            type="button"
            className="tree-toolbar-button tree-fullscreen-button"
            aria-label={isFullscreen ? 'Exit full screen' : 'Open full screen editor'}
            title={isFullscreen ? 'Exit full screen' : 'Open full screen editor'}
            onClick={() => setIsFullscreen((current) => !current)}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            <span>{isFullscreen ? 'Exit full screen' : 'Full screen'}</span>
          </button>
          <button type="button" className="tree-toolbar-button tree-save-button" onClick={onSave} disabled={saving}>
            <Save size={15} />
            <span>{saveLabel}</span>
          </button>
        </div>
      </div>

      <div className="tree-editor-search">
        <label className="tree-search-field">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search object fields and values"
            placeholder="Search fields and values"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" aria-label="Clear tree search" onClick={() => setQuery('')}>
              <X size={15} />
            </button>
          )}
        </label>
        <div className="tree-navigation">
          <span className="tree-search-count">{normalizedQuery ? `${searchIndex.matchCount ? activeMatch + 1 : 0} / ${searchIndex.matchCount} matches` : 'Search keys and values'}</span>
          <button type="button" className="tree-nav-button" onClick={() => moveToMatch(-1)} disabled={!searchIndex.matchCount} aria-label="Previous search match" title="Previous match">↑</button>
          <button type="button" className="tree-nav-button" onClick={() => moveToMatch(1)} disabled={!searchIndex.matchCount} aria-label="Next search match" title="Next match">↓</button>
          <button type="button" className="tree-nav-button" onClick={copyActivePath} aria-label="Copy current field path" title="Copy field path"><Copy size={13} /></button>
          <button type="button" className="tree-nav-button" onClick={() => setExpandedPaths(new Set(allContainerPaths))} title="Expand all fields">Expand all</button>
          <button type="button" className="tree-nav-button" onClick={() => setExpandedPaths(new Set())} title="Collapse all fields">Collapse all</button>
        </div>
        {copyStatus && <span className="tree-copy-status" role="status">{copyStatus}</span>}
        {editorState === 'invalid' && <span className="tree-editor-status error">Fix invalid JSON in Type tree before saving.</span>}
        {editorState === 'saved' && <span className="tree-editor-status success">Saved to the active session.</span>}
      </div>

      <div className="tree-editor-scroll">
        {normalizedQuery && searchIndex.matchCount === 0 ? (
          <div className="tree-search-empty">No matching fields. Try another search.</div>
        ) : (
          <TreeNodeEditor
            label={rootName}
            path={[]}
            value={value}
            depth={0}
            query={normalizedQuery}
            searchPaths={searchIndex.paths}
            expandedPaths={expandedPaths}
            saving={saving}
            onToggle={togglePath}
            onValueChange={updateValue}
            onRename={renameKey}
            onRemove={(path) => onChange(removeAtPath(value, path))}
            onAdd={addChild}
          />
        )}
      </div>
      <div className="tree-editor-footer">
        <span>Edits are drafts until saved. Save before repacking the bundle.</span>
        {editorState === 'invalid' && <span className="tree-editor-status error">Invalid JSON</span>}
      </div>
    </section>
  );
}