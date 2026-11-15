'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';

// The auto-refresh choice survives router.refresh(), pagination and reloads within the tab (sessionStorage).
// Storage can be unavailable (private mode, blocked site data): the in-memory value keeps the checkbox working.
const KEY = 'editorial-log-auto-refresh';
const listeners = new Set<() => void>();
let memory = false;

function read() {
  try {
    const stored = window.sessionStorage.getItem(KEY);
    return stored === null ? memory : stored === '1';
  } catch { return memory; }
}
function write(value: boolean) {
  memory = value;
  try { window.sessionStorage.setItem(KEY, value ? '1' : '0'); } catch { /* storage unavailable: memory only */ }
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function LogRefresh() {
  const router = useRouter();
  const auto = useSyncExternalStore(subscribe, read, () => false);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') router.refresh(); }, 15000);
    return () => clearInterval(timer);
  }, [auto, router]);
  return <div className="log-refresh">
    <button type="button" onClick={() => router.refresh()}>Оновити журнал</button>
    <label><input type="checkbox" checked={auto} onChange={event => write(event.target.checked)} /> Автооновлення кожні 15 с</label>
  </div>;
}
