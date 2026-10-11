import { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import {
  Decoration, EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection, type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { yaml } from "@codemirror/lang-yaml";

export function languageFor(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "py":
      return python();
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "json":
      return json();
    case "md":
      return markdown();
    case "html":
      return html();
    case "css":
      return css();
    case "yml":
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

// Colors come from CSS variables (index.css), so the editor follows light and dark mode.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--syn-function)" },
  { tag: [t.className, t.typeName, t.namespace], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.self, t.special(t.variableName)], color: "var(--syn-keyword)", fontStyle: "italic" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "var(--syn-meta)" },
  { tag: [t.tagName], color: "var(--syn-keyword)" },
  { tag: [t.heading], fontWeight: "600", color: "var(--ink)" },
  { tag: [t.link, t.url], color: "var(--syn-string)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.invalid, color: "#dc3545" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--panel)", color: "var(--ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--ink)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--ink-4)", border: "none", paddingLeft: "6px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", paddingRight: "10px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--sunken) 75%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-2)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, #f15a24 22%, transparent)",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, #f15a24 12%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "var(--sunken)", outline: "1px solid var(--line-strong)" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--ink-4)", cursor: "pointer" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--sunken)", border: "1px solid var(--line)", color: "var(--ink-3)" },
  ".cm-panels": { backgroundColor: "var(--raised)", color: "var(--ink)", borderColor: "var(--line)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-search input, .cm-search button": { fontSize: "12px" },
  ".cm-textfield": { backgroundColor: "var(--panel)", border: "1px solid var(--line)", borderRadius: "6px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--panel)", border: "1px solid var(--line)", borderRadius: "6px" },
  ".cm-tooltip": { backgroundColor: "var(--raised)", border: "1px solid var(--line)", borderRadius: "8px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--sunken)", color: "var(--ink)" },
  ".cm-line.cm-changed": { backgroundColor: "var(--add)", transition: "background-color 1.2s ease-out" },
});

/* Lines someone else just changed (usually the agent) light up for a moment. */
const flash = StateEffect.define<{ from: number; to: number } | null>();
const changedLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flash)) continue;
      if (e.value === null) return Decoration.none;
      const marks = [];
      const doc = tr.state.doc;
      const first = doc.lineAt(Math.min(e.value.from, doc.length)).number;
      const last = doc.lineAt(Math.min(e.value.to, doc.length)).number;
      for (let n = first; n <= last && n - first < 400; n++) marks.push(Decoration.line({ class: "cm-changed" }).range(doc.line(n).from));
      deco = Decoration.set(marks);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const external = Annotation.define<boolean>();

/** The span of `next` that differs from `prev`, by common prefix and suffix. */
function changedSpan(prev: string, next: string) {
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  return { from: start, toPrev: endPrev, toNext: endNext };
}

interface Props {
  path: string;
  doc: string;
  readOnly: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
}

/**
 * A CodeMirror editor that keeps one state per file, so each tab has its own undo history and cursor.
 * `doc` is the text to show; when it changes from outside (the agent wrote the file), the editor
 * updates in place and highlights what changed.
 */
export function CodeEditor({ path, doc, readOnly, onChange, onSave }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const current = useRef(path);
  const ro = useRef(new Compartment());
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  const flashTimer = useRef<number | undefined>(undefined);

  const makeState = (p: string, text: string, readonly: boolean) =>
    EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter({ openText: "▾", closedText: "▸" }),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of("    "),
        syntaxHighlighting(highlight),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        changedLines,
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        languageFor(p),
        theme,
        ro.current.of([EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) cb.current.onChange(u.state.doc.toString());
        }),
      ],
    });

  // Create the view once.
  useEffect(() => {
    const v = new EditorView({ state: makeState(path, doc, readOnly), parent: host.current! });
    view.current = v;
    states.current.set(path, v.state);
    return () => {
      window.clearTimeout(flashTimer.current);
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching tabs: park the old file's state (undo, selection, scroll) and bring back the new one's.
  useEffect(() => {
    const v = view.current;
    if (!v || current.current === path) return;
    states.current.set(current.current, v.state);
    current.current = path;
    const saved = states.current.get(path);
    v.setState(saved && saved.doc.toString() === doc ? saved : makeState(path, doc, readOnly));
    v.dispatch({ effects: ro.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // The text changed from outside: apply it as one minimal change and light it up.
  useEffect(() => {
    const v = view.current;
    if (!v || current.current !== path) return;
    const prev = v.state.doc.toString();
    if (prev === doc) return;
    const span = changedSpan(prev, doc);
    v.dispatch({
      changes: { from: span.from, to: span.toPrev, insert: doc.slice(span.from, span.toNext) },
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
      effects: flash.of({ from: span.from, to: Math.max(span.from, span.toNext - 1) }),
    });
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => view.current?.dispatch({ effects: flash.of(null) }), 2400);
  }, [doc, path]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
