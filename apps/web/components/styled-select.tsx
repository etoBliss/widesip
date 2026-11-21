"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export type StyledSelectOption = { value: string; label: string; group?: string; description?: string; disabled?: boolean };
type Props = {
  options: StyledSelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  density?: "default" | "compact";
};

export function StyledSelect({ options, value, defaultValue, onValueChange, name, id, ariaLabel, placeholder = "Choose an option", disabled = false, required = false, className = "", density = "default" }: Props) {
  const generatedId = useId();
  const controlId = id ?? `styled-select-${generatedId}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [internalValue, setInternalValue] = useState<string | undefined>(defaultValue);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const selectedValue = value !== undefined ? value : internalValue !== undefined ? internalValue : options[0]?.value ?? "";
  const selected = options.find(option => option.value === selectedValue);
  const groups = [...new Set(options.map(option => option.group ?? ""))];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    function onEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>(".styled-select-trigger")?.focus(); }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onEscape); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = rootRef.current?.querySelector<HTMLButtonElement>(".styled-select-trigger");
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, 190);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - rect.bottom - 10;
    const spaceAbove = rect.top - 10;
    const placeAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(130, Math.min(330, placeAbove ? spaceAbove : spaceBelow));
    setMenuStyle({ position: "fixed", left, width: Math.min(width, window.innerWidth - 16), maxHeight, ...(placeAbove ? { bottom: window.innerHeight - rect.top + 7 } : { top: rect.bottom + 7 }) });
  }, [open]);

  function choose(nextValue: string) {
    if (value === undefined) setInternalValue(nextValue);
    onValueChange?.(nextValue);
    setOpen(false);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>(".styled-select-trigger")?.focus());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!open) setOpen(true);
    requestAnimationFrame(() => {
      const enabled = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]:not(:disabled)") ?? [])];
      if (!enabled.length) return;
      const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      enabled[(current + direction + enabled.length) % enabled.length]?.focus();
    });
  }

  return <div ref={rootRef} className={`styled-select${open ? " is-open" : ""} ${density === "compact" ? "is-compact" : ""} ${className}`.trim()} onKeyDown={handleKeyDown}>
    {name && <input className="styled-select-value" type="hidden" name={name} value={selectedValue}/>}
    <button id={controlId} className="styled-select-trigger" type="button" aria-label={ariaLabel} aria-required={required || undefined} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${controlId}-listbox`} disabled={disabled} onClick={() => { const next = !open; setOpen(next); if (next) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("[role=option]:not(:disabled)")?.focus()); }}>
      <span className={`styled-select-current${selected ? "" : " is-placeholder"}`}>{selected?.label ?? placeholder}</span><ChevronDown size={15} aria-hidden="true"/>
    </button>
    {open && typeof document !== "undefined" && createPortal(<div ref={menuRef} className="styled-select-popover" style={menuStyle} id={`${controlId}-listbox`} role="listbox" aria-labelledby={controlId}>
      {groups.map(group => {
        const items = options.filter(option => (option.group ?? "") === group);
        if (!items.length) return null;
        return <div className="styled-select-group" key={group || "default"}>
          {group && <div className="styled-select-group-label">{group}</div>}
          {items.map(option => <button className={`styled-select-option${option.value === selectedValue ? " is-selected" : ""}`} key={option.value} type="button" role="option" aria-selected={option.value === selectedValue} disabled={option.disabled} onClick={() => choose(option.value)}>
            <span className="styled-select-option-copy"><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>{option.value === selectedValue && <Check size={15} aria-hidden="true"/>}
          </button>)}
        </div>;
      })}
      {required && !selectedValue && <span className="styled-select-hint">Choose an option to continue.</span>}
    </div>, document.body)}
  </div>;
}
