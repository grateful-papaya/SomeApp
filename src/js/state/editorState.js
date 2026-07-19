// state/editorState.js
// Owns the live editor session: the CodeMirror view, which file is open,
// per-file scroll/cursor/reading-mode memory, and autosave plumbing.
//
// CONSOLIDATION NOTE
// Previously currentOpenFile / fileScrollPositions / fileCursorPositions each
// existed TWICE — once at window.app.* (written by file-tree.js) and once at
// window.app.state.editor.* (read/written by app.js). The rename handler
// operated on the state.editor copy while everything else used the top-level
// copy, so scroll/cursor migration on rename silently no-op'd. There is now
// exactly one of each, and setCurrentOpenFile() is the single choke point.

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let editorView = null;
let currentOpenFile = null;
let currentTitle = "";
let isSwitchingFile = false;
let autoSaveTimeout = null;
let triggerAutoSave = null;
let codeMirrorModules = null;
let currentPanzoom = null;

const fileScrollPositions = loadJSON("vault_file_scrolls");
const fileCursorPositions = loadJSON("vault_file_cursors");
const fileReadingModeStates = {};

// Flip to true to log every open-file change with a stack trace. This is the
// direct answer to "who changed this value and when?" — set it, reproduce, read
// the console. No framework, no observers; just one guarded console.trace.
const TRACE = false;

export const getEditorView = () => editorView;
export function setEditorView(v) {
  editorView = v;
  // A file switch builds a fresh view whose config knows nothing about
  // reading mode, so re-assert it here rather than making every call site
  // remember to. Cheap and idempotent: it returns immediately when the view
  // already matches the stored per-file state.
  if (v) applyReadingModeToEditor(v);
}

export const getCurrentOpenFile = () => currentOpenFile;
export function setCurrentOpenFile(path) {
  if (TRACE)
    console.trace(
      `[editorState] currentOpenFile: ${currentOpenFile} → ${path}`,
    );
  currentOpenFile = path;
  // Reading mode is remembered per file, so the answer changes here too. The
  // two call orders (view first, then path — or the reverse) are both covered
  // because setEditorView() re-asserts as well.
  applyReadingModeToEditor();
  // One-way mirror for the separately-bundled markdown-preview.js, which reads
  // window.app.currentOpenFile to resolve relative image/link paths. editorState
  // remains the single owner/writer.
  if (window.app) window.app.currentOpenFile = path;
}

export const getCurrentTitle = () => currentTitle;
export function setCurrentTitle(t) {
  currentTitle = t;
}

export const getIsSwitchingFile = () => isSwitchingFile;
export function setIsSwitchingFile(v) {
  isSwitchingFile = v;
}

export const getAutoSaveTimeout = () => autoSaveTimeout;
export function setAutoSaveTimeout(id) {
  autoSaveTimeout = id;
}

export const getTriggerAutoSave = () => triggerAutoSave;
export function setTriggerAutoSave(fn) {
  triggerAutoSave = fn;
}

export const getCodeMirrorModules = () => codeMirrorModules;
export function setCodeMirrorModules(m) {
  codeMirrorModules = m;
}

export const getPanzoom = () => currentPanzoom;
export function setPanzoom(p) {
  currentPanzoom = p;
}

// Collections are returned by live reference; callers mutate in place, e.g.
//   getFileScrollPositions()[path] = scroller.scrollTop;
export const getFileScrollPositions = () => fileScrollPositions;
export const getFileCursorPositions = () => fileCursorPositions;
export const getFileReadingModeStates = () => fileReadingModeStates;

// ── Reading mode ⇄ CodeMirror ──────────────────────────────────────────────
// Reading mode used to be cosmetic only: a `reading-mode` class plus a raw
// contentDOM.setAttribute("contenteditable", "false") from app.js. CodeMirror
// owns that attribute — it re-asserts it from the EditorView.editable facet on
// its next update — so the write was both fragile and, more importantly,
// invisible to the editor's own state. The live-preview extensions had no way
// to tell they were in a reader, which is why markdown, math and tables all
// still revealed their raw source on click and why table editing UI kept
// showing up. Setting the real facets fixes both ends at once: CodeMirror
// stops accepting input and manages contenteditable itself, and
// markdown-preview.js / markdown-table.js can gate reveal on state.readOnly.
//
// The facets go in a Compartment so they can be swapped per toggle. The view
// is rebuilt on every file switch, so the compartment is stored ON the view
// rather than in module scope — reconfiguring a compartment that isn't in a
// given state's config is a silent no-op, which is exactly the bug this
// avoids. The first call for a view appends it; later calls reconfigure.
let cmModulePromise = null;
let cmWarned = false;

function cmApi() {
  const mods = codeMirrorModules;
  if (mods && mods.Compartment && mods.StateEffect)
    return Promise.resolve(mods);
  if (!cmModulePromise) cmModulePromise = import("../libs/codemirror.js");
  return cmModulePromise;
}

export async function applyReadingModeToEditor(view = editorView) {
  if (!view || view.destroyed) return;
  const want = !!fileReadingModeStates[currentOpenFile];
  if (view.state.readOnly === want) return;

  const cm = await cmApi();
  const { Compartment, EditorState, EditorView, StateEffect } = cm || {};
  if (!Compartment || !StateEffect) {
    if (!cmWarned) {
      cmWarned = true;
      console.log(
        "[editorState] reading mode needs Compartment/StateEffect from the " +
          "CodeMirror bundle — rebuild js/libs/codemirror.js from " +
          "codemirror-entry.js (npx esbuild …).",
      );
    }
    return;
  }
  // The await above yields; the view can be torn down by a file switch in
  // between, and dispatching into a dead view throws.
  if (view.destroyed || (editorView && view !== editorView)) return;

  const cfg = [
    EditorState.readOnly.of(want),
    EditorView.editable.of(!want),
  ];
  if (view._readingModeCompartment) {
    view.dispatch({
      effects: view._readingModeCompartment.reconfigure(cfg),
    });
  } else {
    view._readingModeCompartment = new Compartment();
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        view._readingModeCompartment.of(cfg),
      ),
    });
  }
}

// Persistence co-located with the data so callers stop hand-rolling
// JSON.stringify at every call site.
export function persistScrollPositions() {
  localStorage.setItem(
    "vault_file_scrolls",
    JSON.stringify(fileScrollPositions),
  );
}
export function persistCursorPositions() {
  localStorage.setItem(
    "vault_file_cursors",
    JSON.stringify(fileCursorPositions),
  );
}
