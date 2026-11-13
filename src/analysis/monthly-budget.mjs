export async function monthlyAnalysisBudget(db) {
  const {rows:[budget]}=await db.query(`SELECT
    date_trunc('month',now() AT TIME ZONE 'UTC')::date AS month,
    COALESCE((SELECT sum(CASE WHEN status='settled' THEN spent_micros ELSE GREATEST(reserved_micros,spent_micros) END)
      FROM budget_reservations WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date),0)
    +COALESCE((SELECT sum(CASE WHEN state IN ('succeeded','failed') THEN spent_micros ELSE reserved_micros END)
      FROM shorts_plan_calls WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date),0)
    +COALESCE((SELECT sum(CASE WHEN state IN ('succeeded','failed') THEN spent_micros ELSE reserved_micros END)
      FROM montage_plan_ai_calls WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date),0)
    +COALESCE((SELECT sum(CASE WHEN state IN ('succeeded','failed') THEN spent_micros ELSE GREATEST(reserved_micros,spent_micros) END)
      FROM scenario_ai_calls WHERE month=date_trunc('month',now() AT TIME ZONE 'UTC')::date),0) AS used`);
  return budget;
}
