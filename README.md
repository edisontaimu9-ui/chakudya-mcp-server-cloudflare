# Chakudya MCP Server — Cloudflare Workers edition

This is the **Cloudflare Workers** deployment of the Chakudya MCP server. It
exposes the clinical calculators, reference tables, screening workflows and the
Chakudya Nutrition Registry (CNR) lookups as tools over MCP Streamable HTTP.
It serves the same tool set as the older **Render/Express** deployment
(`chakudya-mcp-server` repo). The full list is under **Tools** below.

## What's different from the Render version

Only the hosting-layer plumbing — nothing about the tools or the CNR API
they call:

| | Render version | This (Cloudflare) version |
|---|---|---|
| Runtime | Node.js + Express | Cloudflare Workers (`fetch` handler) |
| MCP transport | SDK's `StreamableHTTPServerTransport`, stateful, session map | Custom stateless one-request-one-response transport (`src/server/mcpTransport.ts`) — see that file for why |
| Config | `process.env` / `.env` via dotenv | `wrangler.jsonc` vars + `wrangler secret put` |
| Crypto (OAuth PKCE) | `node:crypto` | Web Crypto (`crypto.subtle`, `crypto.randomUUID()`) |
| GET/DELETE `/mcp` (SSE stream, session teardown) | Supported | Not supported (405) — no standing session in stateless mode |

The tools in `src/tools/*` and the WHO growth data match the Render version.

## Tools

Tools that need chakudya-api (food lookups, logs, RAG and so on) call it through
the `CHAKUDYA_API` service binding with `CHAKUDYA_API_KEY`, so that secret must be
set. The list below is checked against the code by `src/readme.test.ts`. After
adding or removing a tool, run `UPDATE_README=1 npx vitest run src/readme.test.ts`
to regenerate it.

<!-- TOOLS:START -->
**168 tools:** `activity_energy_calculate`, `activity_energy_list`, `adjusted_body_weight_calculator`, `adult_integrated_screen`, `alcohol_kcal_calculator`, `amputation_weight_adjustment_calculator`, `analyze_meal`, `analyze_meal_clinical`, `aspen_refeeding_initiation_guidance`, `aspen_refeeding_risk_adult`, `aspen_refeeding_risk_pediatric`, `aspen_refeeding_syndrome_severity`, `atwater_food_energy_calculator`, `barcode_lookup`, `bmi_classification`, `bmi_for_age_classify`, `burn_energy_requirements`, `burn_fluid_resuscitation_parkland`, `burn_glucose_glycemic_targets`, `burn_hypermetabolism_pharmacologic_dosing`, `burn_indirect_calorimetry_ree`, `burn_micronutrient_dosing`, `burn_nitrogen_balance`, `burn_pediatric_maintenance_fluid_holliday_segar`, `burn_pediatric_predictive_equations_comparison`, `burn_protein_requirements`, `calculate_nutrients`, `calculate_recipe_nutrition`, `carb_containing_foods_reference`, `carbohydrate_content_calculator`, `carbohydrate_requirement_reference`, `cho_fat_ratio_reference`, `clinical_reference_ranges`, `compare_foods_nutrients`, `delete_food_log_entry`, `diabetes_exchange_lookup`, `disease_information`, `dose_adjustment_stepwise_reference`, `dri_compare_intake`, `dri_eer_reference_lookup`, `dri_electrolyte_water_reference`, `dri_fat_soluble_vitamin_reference`, `dri_life_stages`, `dri_lookup`, `dri_macronutrient_reference`, `dri_mineral_trace_element_reference`, `dri_water_soluble_vitamin_reference`, `electrolyte_replacement_reference`, `energy_factors_reference`, `energy_requirements`, `enteral_formula_lookup`, `fat_requirement_reference`, `fenton_preterm_chart`, `fenton_preterm_classify`, `fenton_preterm_growth`, `fenton_preterm_profile`, `fenton_preterm_references`, `fenton_preterm_velocity`, `fever_stress_ree_adjustment`, `fhir_capability_statement`, `fhir_ncp_diagnosis_codes`, `fhir_ncp_operation`, `fhir_questionnaire`, `find_food`, `find_food_substitutes`, `food_convert`, `food_energy_calculate`, `foods_autocomplete`, `foods_by_category`, `foods_categories`, `generate_nutrition_label`, `get_food_details`, `get_food_log_summary`, `get_food_serving_sizes`, `glim_etiology_classification`, `glim_malnutrition_diagnosis`, `glim_malnutrition_severity`, `glycaemic_index_reference`, `growth_assess`, `handy_carb_measures_reference`, `harris_benedict_bee_calculator`, `ibw_ubw_nutritional_risk_interpreter`, `icu_fluid_requirement_calculator`, `indication_based_energy_protein_reference`, `ingest_document`, `insulin_types_reference`, `intergrowth_preterm_postnatal_growth_zscore`, `iom_dri_eer_calculator`, `list_drug_nutrient_interactions`, `list_favorites`, `list_food_log`, `list_pending_packaged_foods`, `list_view_history`, `log_food_entry`, `log_view`, `macronutrient_distribution_check`, `mealtime_insulin_dose_calculator`, `measures_catalog`, `measures_convert`, `medicine_information`, `memory_consolidate`, `memory_recall`, `memory_write`, `met_activity_energy_calculator`, `muac_cutoff_cmam_2017`, `must_screen`, `nacs_classify_adult`, `nacs_classify_children_0_59m`, `nacs_classify_children_5_17y`, `nacs_classify_pregnant_postpartum`, `nitrogen_balance_calculator`, `npe_nitrogen_ratio_calculator`, `nutrition_calculator`, `nutrition_requirement_weight_selection`, `nutrition_status_classification`, `oedema_ascites_weight_adjustment_reference`, `packaged_food_search`, `parse_ingredients_text`, `pediatric_activity_stress_factor_reference`, `pediatric_energy_requirements`, `pediatric_enteral_feed_advancement`, `pediatric_enteral_feed_plan`, `pediatric_fluid_requirements`, `pediatric_growth_velocity`, `pediatric_growth_velocity_assessment`, `pediatric_protein_requirements`, `percent_ideal_body_weight_calculator`, `percent_usual_body_weight`, `percent_weight_change_calculator`, `pnst_screen`, `potassium_deficit_estimator`, `pregnant_postpartum_integrated_screen`, `preterm_fluid_energy_requirements`, `propofol_fat_content_calculator`, `protein_requirement_by_stress_level`, `pyms_screen`, `rag_retrieve`, `remove_favorite`, `renal_exchange_lookup`, `respiratory_quotient_interpreter`, `retrieve_evidence`, `save_favorite`, `school_age_integrated_screen`, `search_drug_nutrient_interactions`, `search_food`, `search_foods_advanced`, `search_guidelines`, `sga_contributing_factor_classification`, `sga_physical_exam_reference`, `sga_rating_classification`, `spinal_cord_injury_ibw_adjustment_reference`, `stamp_screen`, `stature_from_demi_span`, `stature_from_knee_height`, `stature_from_ulna_length`, `stress_factor_reference`, `strongkids_screen`, `submit_packaged_food`, `submit_packaged_food_photo`, `tee_activity_band_estimator`, `twenty_four_hour_energy_adjustment_reference`, `under5_anthropometric_assessment`, `under5_integrated_screen`, `waist_circumference_interpretation`, `weight_change_significance_interpreter`, `weight_estimate_persons_65_and_older`, `weight_from_knee_height_and_mac`, `who_growth_zscore`
<!-- TOOLS:END -->

## Toolsets

By default a connection gets every tool. To load fewer (smaller context, less
confusion for the model), add `?toolset=` to the MCP URL with one or more names,
comma separated:

```
https://<your-worker>.workers.dev/mcp?toolset=food,screening
```

| Toolset | What it covers |
|---|---|
| `food` | Food composition lookups, packaged foods, recipes, meals, measures, food comparison |
| `user` | Food log, favourites, history, session memory |
| `knowledge` | RAG search over guidelines, evidence retrieval, education tools |
| `energy` | Energy and protein requirements, energy expenditure, critical care nutrition support |
| `clinical` | Adult clinical calculators, body weight and stature, reference ranges, DRI, malnutrition diagnosis, refeeding, diabetes, drug interactions, FHIR |
| `screening` | Malnutrition screening by population |
| `paediatric` | Paediatric assessment, WHO/INTERGROWTH/Fenton growth, BMI-for-age |
| `burns` | Burn nutrition, adult and paediatric |

`all`, or no parameter, means every tool. An unknown name returns a 400 that
lists the valid ones. Each tool belongs to exactly one toolset.

## Result size cap

Tool results are capped at 30,000 characters of JSON (`MCP_MAX_RESULT_CHARS`, set
under `vars` in `wrangler.jsonc`, minimum 2000). When a result is longer, the
largest list in it is cut to the number of items that fit and a `truncated` note
reports `returned` and `total`, so the model knows to narrow its query. Tools that
build their own response instead of calling `ok()` (for example the Fenton SVG
chart) are not capped.

## Logging and tracing

Every response has an `X-Request-Id` header (Cloudflare's `cf-ray` when present,
otherwise a random id). Logs are JSON lines you can follow with `npm run tail`:

- `request`: one per request with `requestId`, `method`, `path`, `status` and
  `ms` (`/health` is not logged).
- `tool_call`: one per tool call with `tool`, `ms`, `isError`, `requestId` and
  `sessionId`. Tool arguments and results are never logged, because they can
  hold a user's food log or memory text.

To trace a failed call, take the `X-Request-Id` from the client and search the
logs for it. `/health` and the MCP handshake report the server version from
`src/version.ts`, which must match `package.json` (a test checks this).

## Lookup cache

Stable lookups are cached in memory for faster repeat calls: the category list
(24 hours) and single foods by id, including `?with_servings` and labels
(`MCP_CACHE_TTL_SECONDS`, default 3600, set under `vars` in `wrangler.jsonc`;
`0` turns caching off). Searches, packaged-food lookups, logs, memory, RAG, POSTs
and admin calls are never cached, and neither are errors. The cache lives in each
Worker isolate, so it is best effort: a cold isolate starts empty, and an update
to a food in chakudya-api can take up to the TTL to show.

## Setup

```bash
npm install
```

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in a dev MCP_AUTH_TOKEN
npm run dev
```

## Deploy

```bash
npx wrangler secret put MCP_AUTH_TOKEN
# required: a chakudya-api consumer key (chakudya-api refuses every data route without a key)
npx wrangler secret put CHAKUDYA_API_KEY
# optional, only if you use admin-gated CNR routes:
npx wrangler secret put CHAKUDYA_ADMIN_API_KEY

npm run deploy
```

**Token in the URL is off by default.** The old `?token=` fallback is disabled
because URLs leak into logs and history. Use `Authorization: Bearer <token>` or
OAuth. If a client can do neither, set `MCP_ALLOW_QUERY_TOKEN` to `"true"` under
`vars` in `wrangler.jsonc`.

Non-secret config (`CHAKUDYA_API_BASE_URL`, `MCP_ALLOWED_ORIGINS`,
`MCP_RATE_LIMIT_PER_MIN`) is set in `wrangler.jsonc` under `vars` — edit that
file directly rather than using `wrangler secret put` for those.

## Malnutrition screening tools (by population)

Each population has one orchestration tool that takes the person's details
once, classifies deterministically, and returns a recommended action. The AI
layer calling them must treat the output as authoritative.

| Population | Tool | What it combines |
|---|---|---|
| 0–59 months | `under5_integrated_screen` | WHO growth z-scores, NACS (oedema, MUAC, WHZ), optional STRONGkids/PNST/PYMS/STAMP |
| 5–17 years | `school_age_integrated_screen` | BMI-for-age (WHO 2007, see below), NACS age-banded MUAC + oedema, optional STRONGkids |
| Adults 18+ (not pregnant/postpartum) | `adult_integrated_screen` | NACS (oedema, MUAC, BMI from weight+height, confirmed >10% weight loss), optional MUST on a separate axis |
| Pregnant / postpartum women | `pregnant_postpartum_integrated_screen` | NACS maternal cut-offs |

Supporting tools: `must_screen` (BAPEN MUST score), `nacs_classify_*`,
`who_growth_zscore`. For BMI-for-age on its own (5y 1m – 19y 0m) call the
Chakudya API's `GET /bmi-for-age/classify` directly.

**BMI-for-age and the Chakudya API.** `school_age_integrated_screen` calls
`GET /bmi-for-age/classify` on the Chakudya API
(WHO 2007 table as printed in Malawi MoH *Eat Well to Live Well*, 2021, Annex 2)
through the same `CHAKUDYA_API` binding / base URL as the other tools. If that
call fails, the screening tool falls back to the in-process WHO 2007 LMS
calculation and says so in `limitations`; if the two ever disagree it uses the
API result and raises a `bmi_for_age_source_disagreement` flag.

**Height that can't be measured standing.** `adult_integrated_screen` accepts
`ulna_length_cm` (18.5–32.0 cm) or `knee_height_cm` + `race` when `height_cm`
is missing, and estimates height with the same functions as
`stature_from_ulna_length` / `stature_from_knee_height` (ulna is tried first).
A measured height always wins. The output labels the height as estimated
(`measurements.height_source`, a `bmi_from_estimated_height` flag, limitations),
shows the BMI range implied by the knee-height equation's published error, and
flags `bmi_classification_uncertain` when that range crosses a NACS cut-off.
One ulna-table cell (men 65+, 30.0 cm = 1.71 m) breaks the source table's own
sequence, so it is refused rather than used. Weight is never estimated: the
published equations' standard errors (about 4–14 kg) are too coarse to base a
BMI on.

**Weight that can't be measured.** With `estimate_weight_if_missing: true` (an
explicit opt-in — never done implicitly) and no `weight_kg`, `adult_integrated_screen`
estimates weight from `muac_mm` plus `calf_circumference_cm` (65+, optional
`subscapular_skinfold_mm` and `knee_height_cm`) and/or `knee_height_cm` + `race`
(ages up to 80), using the same functions as `weight_estimate_persons_65_and_older`
and `weight_from_knee_height_and_mac`; the lowest standard error wins and the others
are listed in `measurements.weight_estimate.alternatives`. The standard errors are
large (about 4–5 kg for the 65+ set, 7–14.5 kg for the race-specific set), so the
output labels the weight as estimated (`weight_source`, `weight_error_kg`, a
`bmi_from_estimated_weight` flag, limitations), gives `bmi_range_from_estimate_error`
(which also folds in a knee-height stature error), and raises
`bmi_classification_uncertain` when that range crosses a NACS BMI cut-off. It affects
BMI and MUST only — never MUAC, oedema or weight-loss findings. It is not available in
`school_age_integrated_screen`.

Age boundaries follow NACS: under-5 tool is 0–59 months, school-age is
60 months to under 18 years, adult is 18+. Not assessed for 5–19 years:
height-for-age and weight-for-age (no reference loaded here).

## Paediatric assessment tools (BND 415)

Beyond the reference look-ups already in `pediatricTools.ts` (fluid, energy,
protein, growth velocity/enteral-feed *tables*, macronutrient ranges — all
sourced from the BND 415 Clinical Nutrition: Paediatric Medicine Resources
sheet), `pediatricAssessmentTools.ts` adds three calculators that turn those
tables into numbers for a specific child:

| Tool | What it does |
|---|---|
| `pediatric_activity_stress_factor_reference` | Activity (confined to bed → high/vigorous) and metabolic stress (starvation → growth failure) factor tables; given a `bmr_kcal_per_day` plus a chosen `activity_level`/`metabolic_condition`, returns a low/mid/high TEE range with the factors multiplied together |
| `pediatric_growth_velocity_assessment` | Calculates a child's actual weight/length/HC velocity from two dated measurements and classifies it against the ASPEN handbook reference (term: 0-24mo sex-specific, 2-<11y; preterm: weight/length/HC velocity + initial weight loss) |
| `pediatric_enteral_feed_plan` | Converts the enteral feed initiation/advancement/goal table into absolute mL/hr or mL/feed for a given weight, plus step count and estimated time to goal |

These are pure calculators (no Chakudya API calls) registered alongside the
existing pediatric tools in `createServer.ts`.

## INTERGROWTH-21st preterm postnatal growth (Fenton alternative)

`intergrowthPretermGrowthTools.ts` adds `intergrowth_preterm_postnatal_growth_zscore` —
weight/length/head-circumference z-score and percentile by postmenstrual age
(27-64 exact weeks), for tracking a preterm infant's growth after birth.

This covers the same clinical purpose as the Fenton 2013 chart, but unlike
Fenton, INTERGROWTH-21st's z-score tables (Villar et al, *Lancet Glob Health*
2015;3:e681-91) are published openly by the INTERGROWTH-21st Network — no
request-to-author needed. The 6 tables in `src/data/intergrowth/*.json`
(weight/length/head-circumference × boys/girls, 38 rows each) are transcribed
verbatim from the official PDFs, not estimated from a chart image.

If/when the equivalent Fenton LMS data comes back from Dr. Fenton, add a
separate `fentonGrowthTools.ts` alongside this one rather than merging them —
keep the two standards distinguishable in tool output since they're not
numerically identical.

## Session memory

`memory_write`, `memory_recall` and `memory_consolidate` are registered tools.
Memory is stored in `chakudya-api` (Supabase `assistant_memory`), keyed by the
MCP session id; `memory_consolidate` needs `CHAKUDYA_ADMIN_API_KEY`.

## Connecting an MCP client

Same as the Render deployment: point the client at
`https://<your-worker-subdomain>.workers.dev/mcp` with
`Authorization: Bearer <MCP_AUTH_TOKEN>`, or use the OAuth flow
(`/.well-known/oauth-authorization-server`) for clients like Claude.ai's
custom connector UI that don't support raw bearer tokens.

## Health check

`GET /health` → `{"status":"ok","service":"chakudya-mcp-server-cloudflare",...}`
