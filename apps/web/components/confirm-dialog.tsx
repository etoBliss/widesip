"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

type ConfirmOptions = { title: string; message: string; confirmLabel?: string; destructive?: boolean };
type PendingConfirm = ConfirmOptions & { resolve: (confirmed: boolean) => void };

export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>(resolve => setPending({ ...options, resolve })), []);
  const finish = useCallback((value: boolean) => { setPending(current => { current?.resolve(value); return null; }); }, []);
  const dialog = pending ? <div className="ui-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) finish(false); }}><section className="ui-modal" role="alertdialog" aria-modal="true" aria-labelledby="ui-modal-title" aria-describedby="ui-modal-description"><div className={`ui-modal-icon${pending.destructive ? " danger" : ""}`}><AlertTriangle size={19}/></div><h2 id="ui-modal-title">{pending.title}</h2><p id="ui-modal-description">{pending.message}</p><footer><button className="button secondary" type="button" onClick={() => finish(false)}>Cancel</button><button className={`button${pending.destructive ? " ui-modal-danger" : ""}`} type="button" onClick={() => finish(true)}>{pending.confirmLabel ?? "Continue"}</button></footer></section></div> : null;
  useEffect(() => { if (!pending) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") finish(false); }; document.addEventListener("keydown", onKeyDown); return () => document.removeEventListener("keydown", onKeyDown); }, [pending, finish]);
  return { confirm, dialog };
}
