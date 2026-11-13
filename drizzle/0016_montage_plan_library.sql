CREATE TABLE editorial_montage_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  is_default boolean NOT NULL DEFAULT false,
  parent_plan_id uuid REFERENCES editorial_montage_plans(id),
  active boolean NOT NULL DEFAULT true,
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec)='object'),
  created_by uuid REFERENCES members(id),
  updated_by uuid REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX editorial_montage_single_default ON editorial_montage_plans(is_default) WHERE is_default;
CREATE INDEX editorial_montage_plans_active ON editorial_montage_plans(active,updated_at DESC);

CREATE TABLE editorial_montage_plan_versions (
  plan_id uuid NOT NULL REFERENCES editorial_montage_plans(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec)='object'),
  changed_by uuid REFERENCES members(id),
  change_source text NOT NULL CHECK (change_source IN ('created','manual','gemini')),
  instruction text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(plan_id,version)
);

ALTER TABLE shorts_renders ADD COLUMN montage_plan_id uuid REFERENCES editorial_montage_plans(id);
ALTER TABLE shorts_renders ADD COLUMN montage_plan_version integer;
ALTER TABLE shorts_plan_calls ADD COLUMN montage_plan_id uuid REFERENCES editorial_montage_plans(id);
ALTER TABLE shorts_plan_calls ADD COLUMN montage_plan_version integer;

CREATE TABLE montage_plan_ai_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES editorial_montage_plans(id),
  requested_by uuid NOT NULL REFERENCES members(id),
  month date NOT NULL,
  model text NOT NULL,
  reserved_micros bigint NOT NULL CHECK (reserved_micros > 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  state text NOT NULL CHECK (state IN ('running','succeeded','failed','unknown')),
  instruction text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX montage_plan_ai_calls_month ON montage_plan_ai_calls(month,state);

INSERT INTO editorial_montage_plans(name,is_default,spec) VALUES(
  'Основний редакційний план',true,
  '{
    "schema":1,
    "format":"9:16",
    "language":"uk",
    "targetDurationSec":45,
    "openingQuote":true,
    "openingQuoteSubtitles":"Українські субтитри під оригінальною відеоцитатою; цитату й аудіо джерела не змінювати",
    "narration":"Лаконічна українська озвучка за перевіреними матеріалами; не вигадувати обставини",
    "narrationVoice":"Soniox Maya uk, 1.15x; голос і швидкість незмінні",
    "factDetail":"Максимальна конкретика: імена, посади, точні дати рішень і подій, суми застави та статус справи. Кожне твердження прив’язати до джерела; невідоме явно позначати як невідоме",
    "visuals":"Одна доречна ілюстрація на кожен слайд. Публічні фото осіб та офіційні зображення документів/будівель використовувати лише з контекстною атрибуцією",
    "layout":"Рівномірно заповнювати кадр від центру; ключовий текст і графіку тримати в безпечних полях для подальшого обрізання",
    "endingStamp":{"enabled":true,"shape":"rectangle","tiltDeg":-5,"largeText":true,"safeMarginPercent":12,"text":"ВЕРДИКТ І СТАН ПЕРЕВІРКИ"},
    "guardrails":"Не підміняти підозру доведеним фактом. Не створювати вигадані цитати, дати, суми, рішення чи зв’язки між людьми. Не обрізати контекст цитати."
  }'::jsonb
);
INSERT INTO editorial_montage_plan_versions(plan_id,version,spec,change_source)
SELECT id,version,spec,'created' FROM editorial_montage_plans WHERE is_default;
