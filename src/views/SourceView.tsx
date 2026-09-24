import { useEffect, useMemo, useState } from 'react';
import { compile } from '../model/compile';
import { parseModelText, toYaml } from '../model/io';
import { Card } from '../ui/components';
import { useStore } from '../ui/store';

/** The whole model as YAML: edit freely, validate, then apply as one undoable change. */
export function SourceView() {
  const model = useStore((s) => s.model);
  const replace = useStore((s) => s.replace);
  const [withLayout, setWithLayout] = useState(false);
  const canonical = useMemo(() => toYaml(model, { withLayout }), [model, withLayout]);
  const [text, setText] = useState(canonical);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setText(canonical);
  }, [canonical, dirty]);

  const check = useMemo(() => {
    if (!dirty) return null;
    try {
      const m = parseModelText(text);
      const c = compile(m);
      return { model: m, errors: c.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`), parse: null };
    } catch (e) {
      return { model: null, errors: [], parse: (e as Error).message };
    }
  }, [text, dirty]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <Card
        title="Model source (YAML)"
        actions={
          <>
            <label className="mr-2 inline-flex items-center gap-1.5 text-[12px] text-ink-2">
              <input type="checkbox" checked={withLayout} onChange={(e) => setWithLayout(e.target.checked)} disabled={dirty} /> include diagram layout
            </label>
            <button
              className="btn sm"
              disabled={!dirty}
              onClick={() => {
                setDirty(false);
                setText(canonical);
              }}
            >
              Revert
            </button>
            <button
              className="btn sm primary"
              disabled={!dirty || !check?.model}
              onClick={() => {
                if (!check?.model) return;
                const next = check.model;
                if (!withLayout) next.layout = model.layout;
                replace(next);
                setDirty(false);
              }}
            >
              Apply
            </button>
          </>
        }
        className="flex min-h-0 flex-1 flex-col"
        pad={false}
      >
        <textarea
          className="h-full min-h-[480px] w-full resize-none bg-surface p-3 font-mono text-[12.5px] leading-[1.55] outline-none"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
        />
      </Card>
      {check ? (
        <div className={`rounded-md p-2 text-[12px] ${check.parse || check.errors.length ? 'bg-critical-wash' : 'bg-surface-2'}`}>
          {check.parse ? (
            <span>YAML error: {check.parse}</span>
          ) : check.errors.length ? (
            <>
              <div className="font-semibold">Parses, but has {check.errors.length} model error(s) — you can still apply and fix them in the editors:</div>
              <ul className="mt-1 list-disc pl-5 font-mono">
                {check.errors.slice(0, 12).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          ) : (
            <span className="text-good-ink">✓ Valid model — Apply to use it (undoable).</span>
          )}
        </div>
      ) : (
        <div className="text-[12px] text-muted">Edits here are applied as one undoable change. The file format is the same as Save YAML / Open.</div>
      )}
    </div>
  );
}
