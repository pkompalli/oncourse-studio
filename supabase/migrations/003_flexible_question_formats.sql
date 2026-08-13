-- Migration 003: Flexible Question Formats
--
-- Adds a format registry table and migrates qb_questions to use
-- format_id + content JSONB instead of rigid MCQ columns.

-- ── 0. Ensure helper function exists ─────────────────────────────

CREATE OR REPLACE FUNCTION qb_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 1. Format Registry ──────────────────────────────────────────

CREATE TABLE qb_question_formats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                    -- "Single Best Answer MCQ"
  slug TEXT NOT NULL UNIQUE,             -- "mcq_single"
  description TEXT,                      -- human-readable description
  schema JSONB NOT NULL DEFAULT '{}',    -- field definitions (machine-readable)
  example JSONB NOT NULL DEFAULT '{}',   -- sample content
  display JSONB NOT NULL DEFAULT '{}',   -- rendering hints
  prompt_guide TEXT,                     -- LLM generation instructions
  source TEXT DEFAULT 'builtin',         -- "builtin" | "user_defined" | "ai_discovered"
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TRIGGER qb_question_formats_updated_at BEFORE UPDATE ON qb_question_formats
  FOR EACH ROW EXECUTE FUNCTION qb_update_updated_at();

-- ── 2. Seed builtin formats ─────────────────────────────────────

INSERT INTO qb_question_formats (name, slug, description, schema, example, display, prompt_guide, source) VALUES

-- MCQ Single Best Answer
(
  'Single Best Answer',
  'mcq_single',
  'Standard MCQ with one correct answer from multiple options',
  '{
    "fields": [
      {"key": "stem", "type": "text", "required": true, "label": "Question Stem"},
      {"key": "options", "type": "keyed_list", "required": true, "label": "Options",
       "item": {"key": "letter", "text": "string"}},
      {"key": "answer", "type": "object", "required": true, "label": "Correct Answer",
       "shape": {"key": "letter"}},
      {"key": "explanation", "type": "text", "required": true, "label": "Explanation"}
    ]
  }',
  '{
    "stem": "A 55-year-old man presents with sudden onset chest pain radiating to the left arm, diaphoresis, and ST elevation in leads II, III, aVF. What is the most likely diagnosis?",
    "options": [
      {"key": "A", "text": "Acute inferior STEMI"},
      {"key": "B", "text": "Unstable angina"},
      {"key": "C", "text": "Pulmonary embolism"},
      {"key": "D", "text": "Aortic dissection"}
    ],
    "answer": {"key": "A"},
    "explanation": "ST elevation in leads II, III, and aVF indicates inferior wall involvement. The acute presentation with diaphoresis and radiation suggests MI rather than angina."
  }',
  '{
    "layout": "stem_then_choices",
    "answer_display": "highlight_key",
    "compact_label": "SBA"
  }',
  'Generate a single-best-answer MCQ. The stem should be a clinical vignette. Provide 4 options labeled A-D. Exactly one option is correct. The explanation should justify why the correct answer is right and why key distractors are wrong.',
  'builtin'
),

-- MCQ Multiple Correct
(
  'Multiple Correct Answers',
  'mcq_multi',
  'MCQ where more than one option may be correct',
  '{
    "fields": [
      {"key": "stem", "type": "text", "required": true, "label": "Question Stem"},
      {"key": "options", "type": "keyed_list", "required": true, "label": "Options",
       "item": {"key": "letter", "text": "string"}},
      {"key": "answer", "type": "object", "required": true, "label": "Correct Answers",
       "shape": {"keys": ["letter"]}},
      {"key": "explanation", "type": "text", "required": true, "label": "Explanation"}
    ]
  }',
  '{
    "stem": "Which of the following are features of nephrotic syndrome? (Select all that apply)",
    "options": [
      {"key": "A", "text": "Proteinuria > 3.5 g/day"},
      {"key": "B", "text": "Hypoalbuminemia"},
      {"key": "C", "text": "RBC casts in urine"},
      {"key": "D", "text": "Peripheral edema"},
      {"key": "E", "text": "Hyperlipidemia"}
    ],
    "answer": {"keys": ["A", "B", "D", "E"]},
    "explanation": "Nephrotic syndrome is characterized by heavy proteinuria, hypoalbuminemia, edema, and hyperlipidemia. RBC casts are a feature of nephritic syndrome."
  }',
  '{
    "layout": "stem_then_choices",
    "answer_display": "highlight_keys",
    "compact_label": "MCQ-M"
  }',
  'Generate a multiple-correct-answers MCQ. The stem should clearly indicate that multiple answers may be correct (e.g., "Select all that apply"). Provide 4-6 options. Two or more options are correct.',
  'builtin'
),

-- True/False
(
  'True or False',
  'true_false',
  'Statement that must be judged as true or false',
  '{
    "fields": [
      {"key": "stem", "type": "text", "required": true, "label": "Statement"},
      {"key": "answer", "type": "object", "required": true, "label": "Answer",
       "shape": {"value": "boolean"}},
      {"key": "explanation", "type": "text", "required": true, "label": "Explanation"}
    ]
  }',
  '{
    "stem": "The mitral valve has three cusps.",
    "answer": {"value": false},
    "explanation": "The mitral (bicuspid) valve has two cusps — anterior and posterior. The tricuspid valve has three cusps."
  }',
  '{
    "layout": "stem_then_boolean",
    "answer_display": "true_false_badge",
    "compact_label": "T/F"
  }',
  'Generate a true/false question. State a factual claim. The answer is either true or false. The explanation must clarify the correct fact.',
  'builtin'
),

-- Match the Following
(
  'Match the Following',
  'match',
  'Match items from two columns',
  '{
    "fields": [
      {"key": "stem", "type": "text", "required": true, "label": "Instructions"},
      {"key": "left", "type": "keyed_list", "required": true, "label": "Column A",
       "item": {"key": "number", "text": "string"}},
      {"key": "right", "type": "keyed_list", "required": true, "label": "Column B",
       "item": {"key": "letter", "text": "string"}},
      {"key": "answer", "type": "object", "required": true, "label": "Matching Pairs",
       "shape": {"pairs": "map<number, letter>"}},
      {"key": "explanation", "type": "text", "required": true, "label": "Explanation"}
    ]
  }',
  '{
    "stem": "Match the nerve with the muscle it innervates:",
    "left": [
      {"key": "1", "text": "Musculocutaneous nerve"},
      {"key": "2", "text": "Radial nerve"},
      {"key": "3", "text": "Median nerve"},
      {"key": "4", "text": "Ulnar nerve"}
    ],
    "right": [
      {"key": "A", "text": "Biceps brachii"},
      {"key": "B", "text": "Triceps brachii"},
      {"key": "C", "text": "Flexor carpi radialis"},
      {"key": "D", "text": "Flexor carpi ulnaris"}
    ],
    "answer": {"pairs": {"1": "A", "2": "B", "3": "C", "4": "D"}},
    "explanation": "Musculocutaneous nerve (C5-C7) innervates biceps. Radial nerve innervates triceps. Median nerve innervates FCR. Ulnar nerve innervates FCU."
  }',
  '{
    "layout": "two_column_match",
    "answer_display": "show_pairs",
    "compact_label": "Match"
  }',
  'Generate a match-the-following question. Provide two columns of 4-6 items each. Each item in Column A matches exactly one item in Column B.',
  'builtin'
),

-- Assertion-Reason
(
  'Assertion and Reason',
  'assertion_reason',
  'Evaluate an assertion and its proposed reason, then determine their relationship',
  '{
    "fields": [
      {"key": "assertion", "type": "text", "required": true, "label": "Assertion"},
      {"key": "reason", "type": "text", "required": true, "label": "Reason"},
      {"key": "options", "type": "keyed_list", "required": true, "label": "Options",
       "item": {"key": "letter", "text": "string"}},
      {"key": "answer", "type": "object", "required": true, "label": "Correct Answer",
       "shape": {"key": "letter"}},
      {"key": "explanation", "type": "text", "required": true, "label": "Explanation"}
    ]
  }',
  '{
    "assertion": "Vitamin K is administered to all newborns at birth.",
    "reason": "Neonates have a sterile gut and cannot synthesize vitamin K endogenously.",
    "options": [
      {"key": "A", "text": "Both assertion and reason are true, and the reason correctly explains the assertion"},
      {"key": "B", "text": "Both assertion and reason are true, but the reason does not correctly explain the assertion"},
      {"key": "C", "text": "Assertion is true but reason is false"},
      {"key": "D", "text": "Assertion is false but reason is true"},
      {"key": "E", "text": "Both assertion and reason are false"}
    ],
    "answer": {"key": "A"},
    "explanation": "Neonates are given vitamin K prophylaxis because their sterile gut lacks bacteria needed for vitamin K synthesis, putting them at risk of hemorrhagic disease of the newborn."
  }',
  '{
    "layout": "assertion_block",
    "answer_display": "highlight_key",
    "compact_label": "A-R"
  }',
  'Generate an assertion-reason question. State an assertion (a factual claim) and a reason (a proposed explanation). Provide the standard 5 options (A-E) for assertion-reason format. The student must evaluate both statements and their relationship.',
  'builtin'
),

-- Extended Matching Question (EMQ)
(
  'Extended Matching Question',
  'emq',
  'A shared option list with multiple clinical scenarios, each requiring selection of the best answer',
  '{
    "fields": [
      {"key": "theme", "type": "text", "required": true, "label": "Theme"},
      {"key": "option_list", "type": "keyed_list", "required": true, "label": "Option List",
       "item": {"key": "letter", "text": "string"}},
      {"key": "items", "type": "list", "required": true, "label": "Clinical Scenarios",
       "item_fields": [
         {"key": "stem", "type": "text", "label": "Scenario"},
         {"key": "answer", "type": "object", "shape": {"key": "letter"}}
       ]},
      {"key": "explanation", "type": "text", "required": true, "label": "Explanation"}
    ]
  }',
  '{
    "theme": "Diagnosis of acute abdominal pain",
    "option_list": [
      {"key": "A", "text": "Acute appendicitis"},
      {"key": "B", "text": "Ectopic pregnancy"},
      {"key": "C", "text": "Acute cholecystitis"},
      {"key": "D", "text": "Perforated peptic ulcer"},
      {"key": "E", "text": "Acute pancreatitis"},
      {"key": "F", "text": "Mesenteric ischemia"},
      {"key": "G", "text": "Diverticulitis"},
      {"key": "H", "text": "Renal colic"}
    ],
    "items": [
      {"stem": "A 25-year-old woman with 6 weeks amenorrhea, right iliac fossa pain, and vaginal spotting.", "answer": {"key": "B"}},
      {"stem": "A 12-year-old boy with periumbilical pain migrating to the right iliac fossa, anorexia, and low-grade fever.", "answer": {"key": "A"}},
      {"stem": "A 60-year-old man with sudden-onset epigastric pain, board-like rigidity, and air under the diaphragm on X-ray.", "answer": {"key": "D"}}
    ],
    "explanation": "Ectopic pregnancy presents with amenorrhea + RIF pain + spotting. Classic appendicitis shows migratory pain. Perforation shows pneumoperitoneum."
  }',
  '{
    "layout": "grouped_items",
    "answer_display": "highlight_key_per_item",
    "compact_label": "EMQ"
  }',
  'Generate an EMQ. Choose a clinical theme. Provide 6-10 options in a shared list. Then write 3-5 clinical scenarios, each with a best answer from the shared list. Options may be used once, more than once, or not at all.',
  'builtin'
),

-- Fill in the Blank
(
  'Fill in the Blank',
  'fill_blank',
  'Complete a statement with the missing word or phrase',
  '{
    "fields": [
      {"key": "stem", "type": "text", "required": true, "label": "Statement with Blank"},
      {"key": "answer", "type": "object", "required": true, "label": "Answer",
       "shape": {"text": "string", "alternatives": ["string"]}},
      {"key": "explanation", "type": "text", "required": true, "label": "Explanation"}
    ]
  }',
  '{
    "stem": "The enzyme deficient in Gaucher disease is ___.",
    "answer": {"text": "Glucocerebrosidase", "alternatives": ["acid beta-glucosidase", "GBA"]},
    "explanation": "Gaucher disease is caused by deficiency of glucocerebrosidase (acid beta-glucosidase), leading to accumulation of glucocerebroside in macrophages."
  }',
  '{
    "layout": "stem_then_input",
    "answer_display": "text_reveal",
    "compact_label": "FIB"
  }',
  'Generate a fill-in-the-blank question. Use ___ to indicate the blank in the stem. The answer should include the primary accepted answer and any alternative acceptable forms.',
  'builtin'
),

-- Short Answer / Viva
(
  'Short Answer',
  'short_answer',
  'Open-ended question requiring a brief written response',
  '{
    "fields": [
      {"key": "stem", "type": "text", "required": true, "label": "Question"},
      {"key": "answer", "type": "object", "required": true, "label": "Model Answer",
       "shape": {"text": "string", "key_points": ["string"]}},
      {"key": "explanation", "type": "text", "required": true, "label": "Detailed Explanation"}
    ]
  }',
  '{
    "stem": "Describe the blood supply of the stomach and its clinical significance in gastrectomy.",
    "answer": {
      "text": "The stomach receives blood from branches of the celiac trunk: left gastric, right gastric, left gastroepiploic (from splenic artery), right gastroepiploic (from gastroduodenal artery), and short gastric arteries.",
      "key_points": [
        "Celiac trunk is the primary source",
        "Rich anastomotic network allows ligation of most arteries",
        "Left gastric artery is the largest direct branch",
        "Short gastric arteries from splenic artery supply the fundus",
        "Knowledge of vascular anatomy is critical during gastrectomy to avoid devascularization"
      ]
    },
    "explanation": "The stomach has a rich blood supply from five main arteries, all derived from the celiac trunk. This extensive anastomotic network means that ligation of up to three of the four main arteries can be tolerated during surgery."
  }',
  '{
    "layout": "stem_then_text",
    "answer_display": "text_reveal",
    "compact_label": "SA"
  }',
  'Generate a short-answer question. The stem should ask for a specific explanation, description, or analysis. Provide a model answer with key points that would earn marks.',
  'builtin'
);

-- ── 3. Add flexible columns to qb_questions ─────────────────────

ALTER TABLE qb_questions
  ADD COLUMN format_id UUID REFERENCES qb_question_formats(id),
  ADD COLUMN content JSONB,
  ADD COLUMN tags JSONB DEFAULT '{}',
  ADD COLUMN media JSONB DEFAULT '[]';

-- ── 4. Migrate existing questions into content JSONB ────────────

-- Build content from existing rigid columns
UPDATE qb_questions SET
  format_id = (SELECT id FROM qb_question_formats WHERE slug = 'mcq_single'),
  content = jsonb_build_object(
    'stem', question,
    'options', (
      SELECT jsonb_agg(jsonb_build_object('key', kv.key, 'text', kv.value))
      FROM jsonb_each_text(options) AS kv(key, value)
    ),
    'answer', jsonb_build_object('key', correct_option),
    'explanation', COALESCE(explanation, '')
  ),
  tags = jsonb_build_object(
    'subject', subject,
    'topic', topic,
    'blooms', blooms_level,
    'difficulty', difficulty
  ),
  media = CASE
    WHEN image_url IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
      'type', COALESCE(image_type, 'image'),
      'url', image_url,
      'description', COALESCE(image_description, ''),
      'source', COALESCE(image_source, 'ai'),
      'search_terms', COALESCE(to_jsonb(image_search_terms), '[]'::jsonb)
    ))
    ELSE '[]'::jsonb
  END
WHERE content IS NULL;

-- ── 5. Make new columns NOT NULL after migration ────────────────
-- (Run these after verifying migration was successful)

-- ALTER TABLE qb_questions ALTER COLUMN format_id SET NOT NULL;
-- ALTER TABLE qb_questions ALTER COLUMN content SET NOT NULL;

-- ── 6. Index ────────────────────────────────────────────────────

CREATE INDEX idx_qb_questions_format_id ON qb_questions(format_id);
CREATE INDEX idx_qb_questions_tags ON qb_questions USING GIN (tags);
CREATE INDEX idx_qb_question_formats_slug ON qb_question_formats(slug);
