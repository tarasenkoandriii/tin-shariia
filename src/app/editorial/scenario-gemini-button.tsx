'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const errors: Record<string,string> = {
  CLAIM_NOT_APPROVED:'Сценарій можна скласти лише для погодженого твердження.',
  BUDGET_EXHAUSTED:'Місячний бюджет Gemini вичерпано.',
  SCENARIO_PENDING:'Gemini ще складає сценарій.',
  SCENARIO_FAILED:'Gemini не зміг скласти сценарій. Спробуйте ще раз.',
  ANALYSIS_DISABLED:'Gemini ще не налаштовано для цього середовища.',
  FORBIDDEN:'Потрібна роль автора.',
};

// One click → Gemini drafts a scenario from the approved claim, its sources and the quoted part of the video.
export function ScenarioGeminiButton({ claimId }: { claimId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  return <p>
    <button type="button" disabled={busy} onClick={async () => {
      if (busy) return;
      setBusy(true); setMessage('');
      try {
        const response = await fetch(`/api/claims/${claimId}/scenario`, { method:'POST', headers:{ 'Content-Type':'application/json' },
          body:JSON.stringify({ requestId:crypto.randomUUID() }) });
        const body = await response.json();
        if (!response.ok) throw Error(body.error?.code ?? 'SCENARIO_FAILED');
        setMessage('Чернетку сценарію створено. Перевірте текст і передайте на погодження.');
        router.refresh();
      } catch (error) {
        setMessage(errors[(error as Error).message] ?? `Не вдалося скласти сценарій (${(error as Error).message}).`);
      } finally { setBusy(false); }
    }}>{busy ? 'Gemini складає сценарій…' : 'Скласти сценарій через Gemini'}</button>
    {message && <output role="status"> {message}</output>}
  </p>;
}
