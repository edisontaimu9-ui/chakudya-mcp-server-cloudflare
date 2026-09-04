import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Part C: Dietary Reference Intakes — by life stage, as compiled in a
 * hospital dietetics guideline (Institute of Medicine DRI tables). Distinct
 * from the DRI EER Table 2.2 (energy only, Nelms/Ireton-Jones) already in
 * energyExpenditureTools.ts — these tables cover macronutrients, vitamins,
 * minerals/trace elements, and electrolytes/water, each broken out by
 * life stage (infants, children, males, females, pregnancy, lactation).
 *
 * Pure table lookup — no Chakudya API calls. Values marked with an asterisk
 * in the source are Adequate Intakes (AIs) rather than RDAs; reproduced here
 * as `is_adequate_intake: true` per row/nutrient where noted in the source.
 *
 * Five tools, all sharing the same life_stage_search lookup pattern:
 *   - dri_macronutrient_reference
 *   - dri_water_soluble_vitamin_reference
 *   - dri_fat_soluble_vitamin_reference
 *   - dri_mineral_trace_element_reference
 *   - dri_electrolyte_water_reference
 */

const DRI_DISCLAIMER =
  "Reference values only, from published Institute of Medicine Dietary Reference Intake tables as " +
  "compiled in a hospital dietetics guideline. Individualize to the patient; these are population " +
  "reference values, not per-patient prescriptions.";

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

function lookup<T extends { life_stage: string }>(table: T[], search: string | undefined): T[] | { errorMsg: string } {
  if (search === undefined) return table;
  const rows = table.filter((r) => r.life_stage.toLowerCase().includes(search.toLowerCase()));
  if (rows.length === 0) return { errorMsg: `No life stage matched "${search}". Omit life_stage_search to see the full table.` };
  return rows;
}

// ── 3.1 Energy and Macronutrients ───────────────────────────────────────────
interface MacronutrientRow {
  life_stage: string;
  energy_kcal_male?: number;
  energy_kcal_female?: number;
  energy_note?: string;
  carbs_g: number;
  fibre_g: number | string;
  fats_g: string;
  omega6_g: number | string;
  omega3_g: number;
  protein_g: number | string;
}

const MACRONUTRIENT_TABLE: MacronutrientRow[] = [
  { life_stage: "0-6 months", energy_kcal_male: 570, energy_kcal_female: 520, carbs_g: 60, fibre_g: "undetermined", fats_g: "undetermined", omega6_g: 31, omega3_g: 0.5, protein_g: 9.1 },
  { life_stage: "7-12 months", carbs_g: 95, fibre_g: "undetermined", fats_g: "30", omega6_g: 4.6, omega3_g: 0.5, protein_g: 13.5, energy_note: "See combined table; energy for infants split 0-6/7-12 months only" },
  { life_stage: "1-3 years", energy_kcal_male: 1046, energy_kcal_female: 992, carbs_g: 130, fibre_g: 19, fats_g: "30-40", omega6_g: 7, omega3_g: 0.7, protein_g: 13 },
  { life_stage: "4-8 years", energy_kcal_male: 1742, energy_kcal_female: 1642, carbs_g: 130, fibre_g: 25, fats_g: "25-35", omega6_g: 10, omega3_g: 0.9, protein_g: 19 },
  { life_stage: "9-13 years", energy_kcal_male: 2279, energy_kcal_female: 2071, carbs_g: 130, fibre_g: "M 31, F 26", fats_g: "25-35", omega6_g: "M 12, F 10", omega3_g: 1.1, protein_g: 34 },
  { life_stage: "Males 14-18 years", energy_kcal_male: 3152, carbs_g: 130, fibre_g: 38, fats_g: "25-35", omega6_g: 16, omega3_g: 1.6, protein_g: 52 },
  { life_stage: "Males 19-30 years", energy_note: "Depends on body size", carbs_g: 130, fibre_g: 38, fats_g: "20-35", omega6_g: 17, omega3_g: 1.6, protein_g: 56 },
  { life_stage: "Males 31-50 years", energy_note: "Depends on body size", carbs_g: 130, fibre_g: 38, fats_g: "20-35", omega6_g: 17, omega3_g: 1.6, protein_g: 56 },
  { life_stage: "Males 51-70 years", energy_note: "Depends on body size", carbs_g: 130, fibre_g: 30, fats_g: "20-35", omega6_g: 14, omega3_g: 1.6, protein_g: 56 },
  { life_stage: "Males >70 years", energy_note: "Depends on body size", carbs_g: 130, fibre_g: 30, fats_g: "20-35", omega6_g: 14, omega3_g: 1.6, protein_g: 56 },
  { life_stage: "Females 14-18 years", energy_kcal_female: 2366, carbs_g: 130, fibre_g: 26, fats_g: "25-35", omega6_g: 11, omega3_g: 1.1, protein_g: 46 },
  { life_stage: "Females 19-30 years", energy_note: "Depends on body size", carbs_g: 130, fibre_g: 25, fats_g: "20-35", omega6_g: 17, omega3_g: 1.1, protein_g: 46 },
  { life_stage: "Females 31-50 years", energy_note: "Depends on body size", carbs_g: 130, fibre_g: 25, fats_g: "20-35", omega6_g: 17, omega3_g: 1.1, protein_g: 46 },
  { life_stage: "Females 51-70 years", energy_note: "Depends on body size", carbs_g: 130, fibre_g: 21, fats_g: "20-35", omega6_g: 14, omega3_g: 1.1, protein_g: 46 },
  { life_stage: "Females >70 years", energy_note: "Depends on body size", carbs_g: 130, fibre_g: 21, fats_g: "20-35", omega6_g: 14, omega3_g: 1.1, protein_g: 46 },
  { life_stage: "Pregnancy 18 years", energy_note: "2368-2820 kcal", carbs_g: 175, fibre_g: 28, fats_g: "20-35", omega6_g: 13, omega3_g: 1.4, protein_g: 71 },
  { life_stage: "Pregnancy 19-50 years", energy_note: "2403-2855 kcal", carbs_g: 175, fibre_g: 28, fats_g: "20-35", omega6_g: 13, omega3_g: 1.4, protein_g: 71 },
  { life_stage: "Lactation 18 years", energy_note: "2698-2768 kcal", carbs_g: 210, fibre_g: 29, fats_g: "20-35", omega6_g: 13, omega3_g: 1.3, protein_g: 71 },
  { life_stage: "Lactation 19-50 years", energy_note: "2733-2803 kcal", carbs_g: 210, fibre_g: 29, fats_g: "20-35", omega6_g: 13, omega3_g: 1.3, protein_g: 71 },
];

// ── 3.2 Water-soluble vitamins ──────────────────────────────────────────────
interface WaterSolubleVitaminRow {
  life_stage: string;
  vitamin_c_mg: number;
  thiamine_mg: number;
  riboflavin_mg: number;
  niacin_mg: number;
  vitamin_b6_mg: number;
  folate_ug: number;
  vitamin_b12_ug: number;
  pantothenic_acid_mg: number;
  biotin_ug: number;
  choline_mg: number;
}

const WATER_SOLUBLE_VITAMIN_TABLE: WaterSolubleVitaminRow[] = [
  { life_stage: "0-6 months", vitamin_c_mg: 40, thiamine_mg: 0.2, riboflavin_mg: 0.3, niacin_mg: 2, vitamin_b6_mg: 0.1, folate_ug: 65, vitamin_b12_ug: 0.4, pantothenic_acid_mg: 1.7, biotin_ug: 5, choline_mg: 125 },
  { life_stage: "7-12 months", vitamin_c_mg: 50, thiamine_mg: 0.3, riboflavin_mg: 0.4, niacin_mg: 4, vitamin_b6_mg: 0.3, folate_ug: 80, vitamin_b12_ug: 0.5, pantothenic_acid_mg: 1.8, biotin_ug: 6, choline_mg: 150 },
  { life_stage: "1-3 years", vitamin_c_mg: 15, thiamine_mg: 0.5, riboflavin_mg: 0.5, niacin_mg: 6, vitamin_b6_mg: 0.5, folate_ug: 150, vitamin_b12_ug: 0.9, pantothenic_acid_mg: 2, biotin_ug: 8, choline_mg: 200 },
  { life_stage: "4-8 years", vitamin_c_mg: 25, thiamine_mg: 0.6, riboflavin_mg: 0.6, niacin_mg: 8, vitamin_b6_mg: 0.6, folate_ug: 200, vitamin_b12_ug: 1.2, pantothenic_acid_mg: 3, biotin_ug: 12, choline_mg: 250 },
  { life_stage: "9-13 years", vitamin_c_mg: 45, thiamine_mg: 0.9, riboflavin_mg: 0.9, niacin_mg: 12, vitamin_b6_mg: 1.0, folate_ug: 300, vitamin_b12_ug: 1.8, pantothenic_acid_mg: 4, biotin_ug: 20, choline_mg: 375 },
  { life_stage: "Males 14-18 years", vitamin_c_mg: 75, thiamine_mg: 1.2, riboflavin_mg: 1.3, niacin_mg: 16, vitamin_b6_mg: 1.3, folate_ug: 400, vitamin_b12_ug: 2.4, pantothenic_acid_mg: 5, biotin_ug: 25, choline_mg: 550 },
  { life_stage: "Males 19-30 years", vitamin_c_mg: 90, thiamine_mg: 1.2, riboflavin_mg: 1.3, niacin_mg: 16, vitamin_b6_mg: 1.3, folate_ug: 400, vitamin_b12_ug: 2.4, pantothenic_acid_mg: 5, biotin_ug: 30, choline_mg: 550 },
  { life_stage: "Males 31-50 years", vitamin_c_mg: 90, thiamine_mg: 1.2, riboflavin_mg: 1.3, niacin_mg: 16, vitamin_b6_mg: 1.3, folate_ug: 400, vitamin_b12_ug: 2.4, pantothenic_acid_mg: 5, biotin_ug: 30, choline_mg: 550 },
  { life_stage: "Males 51-70 years", vitamin_c_mg: 90, thiamine_mg: 1.2, riboflavin_mg: 1.3, niacin_mg: 16, vitamin_b6_mg: 1.7, folate_ug: 400, vitamin_b12_ug: 2.4, pantothenic_acid_mg: 5, biotin_ug: 30, choline_mg: 550 },
  { life_stage: "Males >70 years", vitamin_c_mg: 90, thiamine_mg: 1.2, riboflavin_mg: 1.3, niacin_mg: 16, vitamin_b6_mg: 1.7, folate_ug: 400, vitamin_b12_ug: 2.4, pantothenic_acid_mg: 5, biotin_ug: 30, choline_mg: 550 },
  { life_stage: "Females 14-18 years", vitamin_c_mg: 65, thiamine_mg: 1.0, riboflavin_mg: 1.0, niacin_mg: 14, vitamin_b6_mg: 1.2, folate_ug: 400, vitamin_b12_ug: 2.4, pantothenic_acid_mg: 5, biotin_ug: 25, choline_mg: 400 },
  { life_stage: "Females 19-30 years", vitamin_c_mg: 75, thiamine_mg: 1.1, riboflavin_mg: 1.1, niacin_mg: 14, vitamin_b6_mg: 1.3, folate_ug: 400, vitamin_b12_ug: 2.4, pantothenic_acid_mg: 5, biotin_ug: 30, choline_mg: 425 },
  { life_stage: "Females 31-50 years", vitamin_c_mg: 75, thiamine_mg: 1.1, riboflavin_mg: 1.1, niacin_mg: 14, vitamin_b6_mg: 1.3, folate_ug: 400, vitamin_b12_ug: 2.4, pantothenic_acid_mg: 5, biotin_ug: 30, choline_mg: 425 },
  { life_stage: "Females 51-70 years", vitamin_c_mg: 75, thiamine_mg: 1.1, riboflavin_mg: 1.1, niacin_mg: 14, vitamin_b6_mg: 1.5, folate_ug: 400, vitamin_b12_ug: 2.4, pantothenic_acid_mg: 5, biotin_ug: 30, choline_mg: 425 },
  { life_stage: "Females >70 years", vitamin_c_mg: 75, thiamine_mg: 1.1, riboflavin_mg: 1.1, niacin_mg: 14, vitamin_b6_mg: 1.5, folate_ug: 400, vitamin_b12_ug: 2.4, pantothenic_acid_mg: 5, biotin_ug: 30, choline_mg: 425 },
  { life_stage: "Pregnancy 18 years", vitamin_c_mg: 80, thiamine_mg: 1.4, riboflavin_mg: 1.4, niacin_mg: 18, vitamin_b6_mg: 1.9, folate_ug: 600, vitamin_b12_ug: 2.6, pantothenic_acid_mg: 6, biotin_ug: 30, choline_mg: 450 },
  { life_stage: "Pregnancy 19-50 years", vitamin_c_mg: 85, thiamine_mg: 1.4, riboflavin_mg: 1.4, niacin_mg: 18, vitamin_b6_mg: 1.9, folate_ug: 600, vitamin_b12_ug: 2.6, pantothenic_acid_mg: 6, biotin_ug: 30, choline_mg: 450 },
  { life_stage: "Lactation 18 years", vitamin_c_mg: 115, thiamine_mg: 1.4, riboflavin_mg: 1.6, niacin_mg: 17, vitamin_b6_mg: 2.0, folate_ug: 500, vitamin_b12_ug: 2.8, pantothenic_acid_mg: 7, biotin_ug: 35, choline_mg: 550 },
  { life_stage: "Lactation 19-50 years", vitamin_c_mg: 120, thiamine_mg: 1.4, riboflavin_mg: 1.6, niacin_mg: 17, vitamin_b6_mg: 2.0, folate_ug: 500, vitamin_b12_ug: 2.8, pantothenic_acid_mg: 7, biotin_ug: 35, choline_mg: 550 },
];

// ── 3.3 Fat-soluble vitamins ────────────────────────────────────────────────
interface FatSolubleVitaminRow {
  life_stage: string;
  vitamin_a_ug: number;
  vitamin_d_iu: number;
  vitamin_e_mg: number;
  vitamin_k_ug: number;
}

const FAT_SOLUBLE_VITAMIN_TABLE: FatSolubleVitaminRow[] = [
  { life_stage: "0-6 months", vitamin_a_ug: 40, vitamin_d_iu: 400, vitamin_e_mg: 4, vitamin_k_ug: 2 },
  { life_stage: "7-12 months", vitamin_a_ug: 50, vitamin_d_iu: 400, vitamin_e_mg: 5, vitamin_k_ug: 2.5 },
  { life_stage: "1-3 years", vitamin_a_ug: 15, vitamin_d_iu: 600, vitamin_e_mg: 6, vitamin_k_ug: 30 },
  { life_stage: "4-8 years", vitamin_a_ug: 25, vitamin_d_iu: 600, vitamin_e_mg: 7, vitamin_k_ug: 55 },
  { life_stage: "9-13 years", vitamin_a_ug: 45, vitamin_d_iu: 600, vitamin_e_mg: 11, vitamin_k_ug: 60 },
  { life_stage: "Males 14-18 years", vitamin_a_ug: 75, vitamin_d_iu: 600, vitamin_e_mg: 15, vitamin_k_ug: 75 },
  { life_stage: "Males 19-30 years", vitamin_a_ug: 90, vitamin_d_iu: 600, vitamin_e_mg: 15, vitamin_k_ug: 120 },
  { life_stage: "Males 31-50 years", vitamin_a_ug: 90, vitamin_d_iu: 600, vitamin_e_mg: 15, vitamin_k_ug: 120 },
  { life_stage: "Males 51-70 years", vitamin_a_ug: 90, vitamin_d_iu: 600, vitamin_e_mg: 15, vitamin_k_ug: 120 },
  { life_stage: "Males >70 years", vitamin_a_ug: 90, vitamin_d_iu: 800, vitamin_e_mg: 15, vitamin_k_ug: 120 },
  { life_stage: "Females 14-18 years", vitamin_a_ug: 65, vitamin_d_iu: 600, vitamin_e_mg: 15, vitamin_k_ug: 75 },
  { life_stage: "Females 19-30 years", vitamin_a_ug: 75, vitamin_d_iu: 600, vitamin_e_mg: 15, vitamin_k_ug: 90 },
  { life_stage: "Females 31-50 years", vitamin_a_ug: 75, vitamin_d_iu: 600, vitamin_e_mg: 15, vitamin_k_ug: 90 },
  { life_stage: "Females 51-70 years", vitamin_a_ug: 75, vitamin_d_iu: 600, vitamin_e_mg: 15, vitamin_k_ug: 90 },
  { life_stage: "Females >70 years", vitamin_a_ug: 75, vitamin_d_iu: 800, vitamin_e_mg: 15, vitamin_k_ug: 90 },
  { life_stage: "Pregnancy 18 years", vitamin_a_ug: 80, vitamin_d_iu: 600, vitamin_e_mg: 15, vitamin_k_ug: 75 },
  { life_stage: "Pregnancy 19-50 years", vitamin_a_ug: 85, vitamin_d_iu: 600, vitamin_e_mg: 15, vitamin_k_ug: 90 },
  { life_stage: "Lactation 18 years", vitamin_a_ug: 115, vitamin_d_iu: 600, vitamin_e_mg: 19, vitamin_k_ug: 75 },
  { life_stage: "Lactation 19-50 years", vitamin_a_ug: 120, vitamin_d_iu: 600, vitamin_e_mg: 19, vitamin_k_ug: 90 },
];

// ── 3.4 Minerals and trace elements ─────────────────────────────────────────
interface MineralTraceElementRow {
  life_stage: string;
  calcium_mg: number;
  phosphorus_mg: number;
  magnesium_mg: number;
  iron_mg: number;
  zinc_mg: number;
  iodine_ug: number;
  fluoride_mg: number;
  selenium_ug: number;
}

const MINERAL_TRACE_ELEMENT_TABLE: MineralTraceElementRow[] = [
  { life_stage: "0-6 months", calcium_mg: 200, phosphorus_mg: 100, magnesium_mg: 30, iron_mg: 0.27, zinc_mg: 2, iodine_ug: 110, fluoride_mg: 0.01, selenium_ug: 15 },
  { life_stage: "7-12 months", calcium_mg: 200, phosphorus_mg: 275, magnesium_mg: 75, iron_mg: 11, zinc_mg: 3, iodine_ug: 130, fluoride_mg: 0.5, selenium_ug: 20 },
  { life_stage: "1-3 years", calcium_mg: 700, phosphorus_mg: 460, magnesium_mg: 80, iron_mg: 7, zinc_mg: 3, iodine_ug: 90, fluoride_mg: 0.7, selenium_ug: 20 },
  { life_stage: "4-8 years", calcium_mg: 1000, phosphorus_mg: 500, magnesium_mg: 130, iron_mg: 10, zinc_mg: 5, iodine_ug: 90, fluoride_mg: 1.1, selenium_ug: 30 },
  { life_stage: "9-13 years", calcium_mg: 1300, phosphorus_mg: 1250, magnesium_mg: 240, iron_mg: 8, zinc_mg: 8, iodine_ug: 120, fluoride_mg: 2.0, selenium_ug: 40 },
  { life_stage: "Males 14-18 years", calcium_mg: 1300, phosphorus_mg: 1250, magnesium_mg: 410, iron_mg: 11, zinc_mg: 11, iodine_ug: 150, fluoride_mg: 3.2, selenium_ug: 55 },
  { life_stage: "Males 19-30 years", calcium_mg: 1000, phosphorus_mg: 700, magnesium_mg: 400, iron_mg: 8, zinc_mg: 11, iodine_ug: 150, fluoride_mg: 3.8, selenium_ug: 55 },
  { life_stage: "Males 31-50 years", calcium_mg: 1000, phosphorus_mg: 700, magnesium_mg: 420, iron_mg: 8, zinc_mg: 11, iodine_ug: 150, fluoride_mg: 3.8, selenium_ug: 55 },
  { life_stage: "Males 51-70 years", calcium_mg: 1000, phosphorus_mg: 700, magnesium_mg: 420, iron_mg: 8, zinc_mg: 11, iodine_ug: 150, fluoride_mg: 3.8, selenium_ug: 55 },
  { life_stage: "Males >70 years", calcium_mg: 1200, phosphorus_mg: 700, magnesium_mg: 420, iron_mg: 8, zinc_mg: 11, iodine_ug: 150, fluoride_mg: 3.8, selenium_ug: 55 },
  { life_stage: "Females 14-18 years", calcium_mg: 1300, phosphorus_mg: 1250, magnesium_mg: 360, iron_mg: 15, zinc_mg: 9, iodine_ug: 150, fluoride_mg: 2.9, selenium_ug: 55 },
  { life_stage: "Females 19-30 years", calcium_mg: 1000, phosphorus_mg: 700, magnesium_mg: 310, iron_mg: 18, zinc_mg: 8, iodine_ug: 150, fluoride_mg: 3.1, selenium_ug: 55 },
  { life_stage: "Females 31-50 years", calcium_mg: 1000, phosphorus_mg: 700, magnesium_mg: 320, iron_mg: 18, zinc_mg: 8, iodine_ug: 150, fluoride_mg: 3.1, selenium_ug: 55 },
  { life_stage: "Females 51-70 years", calcium_mg: 1200, phosphorus_mg: 700, magnesium_mg: 320, iron_mg: 6, zinc_mg: 8, iodine_ug: 150, fluoride_mg: 3.1, selenium_ug: 55 },
  { life_stage: "Females >70 years", calcium_mg: 1200, phosphorus_mg: 700, magnesium_mg: 320, iron_mg: 6, zinc_mg: 8, iodine_ug: 150, fluoride_mg: 3.1, selenium_ug: 55 },
  { life_stage: "Pregnancy 18 years", calcium_mg: 1300, phosphorus_mg: 1250, magnesium_mg: 400, iron_mg: 27, zinc_mg: 13, iodine_ug: 220, fluoride_mg: 2.9, selenium_ug: 60 },
  { life_stage: "Pregnancy 19-50 years", calcium_mg: 1000, phosphorus_mg: 700, magnesium_mg: 350, iron_mg: 27, zinc_mg: 11, iodine_ug: 220, fluoride_mg: 3.1, selenium_ug: 60 },
  { life_stage: "Lactation 18 years", calcium_mg: 1300, phosphorus_mg: 1250, magnesium_mg: 360, iron_mg: 10, zinc_mg: 14, iodine_ug: 290, fluoride_mg: 2.9, selenium_ug: 70 },
  { life_stage: "Lactation 19-50 years", calcium_mg: 1000, phosphorus_mg: 700, magnesium_mg: 320, iron_mg: 9, zinc_mg: 12, iodine_ug: 290, fluoride_mg: 3.1, selenium_ug: 70 },
];

// ── 3.5 Electrolytes and water ──────────────────────────────────────────────
interface ElectrolyteWaterRow {
  life_stage: string;
  sodium_g: number;
  chloride_g: number;
  potassium_g: number;
  water_l: number | string;
}

const ELECTROLYTE_WATER_TABLE: ElectrolyteWaterRow[] = [
  { life_stage: "0-6 months", sodium_g: 0.12, chloride_g: 0.18, potassium_g: 0.4, water_l: 0.7 },
  { life_stage: "7-12 months", sodium_g: 0.37, chloride_g: 0.57, potassium_g: 0.7, water_l: 0.8 },
  { life_stage: "1-3 years", sodium_g: 1.0, chloride_g: 1.5, potassium_g: 3.0, water_l: 1.3 },
  { life_stage: "4-8 years", sodium_g: 1.2, chloride_g: 1.9, potassium_g: 3.8, water_l: 1.7 },
  { life_stage: "9-13 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 4.5, water_l: "M 2.4, F 2.1" },
  { life_stage: "Males 14-18 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 4.7, water_l: 3.3 },
  { life_stage: "Males 19-30 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 4.7, water_l: 3.7 },
  { life_stage: "Males 31-50 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 4.7, water_l: 3.7 },
  { life_stage: "Males 51-70 years", sodium_g: 1.3, chloride_g: 2.0, potassium_g: 4.7, water_l: 3.7 },
  { life_stage: "Males >70 years", sodium_g: 1.2, chloride_g: 1.8, potassium_g: 4.7, water_l: 3.7 },
  { life_stage: "Females 14-18 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 4.7, water_l: 2.3 },
  { life_stage: "Females 19-30 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 4.7, water_l: 2.7 },
  { life_stage: "Females 31-50 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 4.7, water_l: 2.7 },
  { life_stage: "Females 51-70 years", sodium_g: 1.3, chloride_g: 2.0, potassium_g: 4.7, water_l: 2.7 },
  { life_stage: "Females >70 years", sodium_g: 1.2, chloride_g: 1.8, potassium_g: 4.7, water_l: 2.7 },
  { life_stage: "Pregnancy 18 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 4.7, water_l: 3.0 },
  { life_stage: "Pregnancy 19-50 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 4.7, water_l: 3.0 },
  { life_stage: "Lactation 18 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 5.1, water_l: 3.8 },
  { life_stage: "Lactation 19-50 years", sodium_g: 1.5, chloride_g: 2.3, potassium_g: 5.1, water_l: 3.8 },
];

export function registerDietaryReferenceIntakeTables(server: McpServer) {
  server.registerTool(
    "dri_macronutrient_reference",
    {
      title: "DRI Macronutrient Reference by Life Stage",
      description:
        "Look up energy, carbohydrate, fibre, fat, omega-6, omega-3, and protein DRI values by life stage " +
        "(infants through adults, pregnancy, lactation). Pass life_stage_search matching part of a label " +
        "(e.g. 'Males 19-30', 'Pregnancy', '4-8'); omit to return the full table.",
      inputSchema: { life_stage_search: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("dri_macronutrient_reference", async ({ life_stage_search }) => {
      const result = lookup(MACRONUTRIENT_TABLE, life_stage_search);
      if ("errorMsg" in result) return err(result.errorMsg);
      return ok({ results: result }, { disclaimer: DRI_DISCLAIMER, citation: "Institute of Medicine DRI tables" });
    })
  );

  server.registerTool(
    "dri_water_soluble_vitamin_reference",
    {
      title: "DRI Water-Soluble Vitamin Reference by Life Stage",
      description:
        "Look up vitamin C, thiamine, riboflavin, niacin, vitamin B6, folate, vitamin B12, pantothenic " +
        "acid, biotin, and choline DRI values by life stage. Pass life_stage_search matching part of a " +
        "label; omit to return the full table.",
      inputSchema: { life_stage_search: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("dri_water_soluble_vitamin_reference", async ({ life_stage_search }) => {
      const result = lookup(WATER_SOLUBLE_VITAMIN_TABLE, life_stage_search);
      if ("errorMsg" in result) return err(result.errorMsg);
      return ok({ results: result }, { disclaimer: DRI_DISCLAIMER, citation: "Institute of Medicine DRI tables" });
    })
  );

  server.registerTool(
    "dri_fat_soluble_vitamin_reference",
    {
      title: "DRI Fat-Soluble Vitamin Reference by Life Stage",
      description:
        "Look up vitamin A, vitamin D, vitamin E, and vitamin K DRI values by life stage. Pass " +
        "life_stage_search matching part of a label; omit to return the full table.",
      inputSchema: { life_stage_search: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("dri_fat_soluble_vitamin_reference", async ({ life_stage_search }) => {
      const result = lookup(FAT_SOLUBLE_VITAMIN_TABLE, life_stage_search);
      if ("errorMsg" in result) return err(result.errorMsg);
      return ok({ results: result }, { disclaimer: DRI_DISCLAIMER, citation: "Institute of Medicine DRI tables" });
    })
  );

  server.registerTool(
    "dri_mineral_trace_element_reference",
    {
      title: "DRI Mineral & Trace Element Reference by Life Stage",
      description:
        "Look up calcium, phosphorus, magnesium, iron, zinc, iodine, fluoride, and selenium DRI values by " +
        "life stage. Pass life_stage_search matching part of a label; omit to return the full table.",
      inputSchema: { life_stage_search: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("dri_mineral_trace_element_reference", async ({ life_stage_search }) => {
      const result = lookup(MINERAL_TRACE_ELEMENT_TABLE, life_stage_search);
      if ("errorMsg" in result) return err(result.errorMsg);
      return ok(
        {
          results: result,
          note:
            "Iron: values for vegetarians are EARs (not RDAs), accounting for lower iron bioavailability in " +
            "many vegetarian/vegan diets. RDA assumes girls <14y don't menstruate; increase by ~2.5mg/day if " +
            "menarche is before 14y. Increase by ~2.9mg/day (boys) or ~1.1mg/day (girls) during the " +
            "adolescent growth spurt. Oral contraceptives may reduce iron requirements in pre-menopausal " +
            "women; post-menopausal women on HRT who continue to menstruate may have higher requirements " +
            "than those not on HRT.",
        },
        { disclaimer: DRI_DISCLAIMER, citation: "Institute of Medicine DRI tables" }
      );
    })
  );

  server.registerTool(
    "dri_electrolyte_water_reference",
    {
      title: "DRI Electrolyte & Water Reference by Life Stage",
      description:
        "Look up sodium, chloride, potassium, and water DRI/Adequate Intake values by life stage. Pass " +
        "life_stage_search matching part of a label; omit to return the full table.",
      inputSchema: { life_stage_search: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("dri_electrolyte_water_reference", async ({ life_stage_search }) => {
      const result = lookup(ELECTROLYTE_WATER_TABLE, life_stage_search);
      if ("errorMsg" in result) return err(result.errorMsg);
      return ok({ results: result }, { disclaimer: DRI_DISCLAIMER, citation: "Institute of Medicine DRI tables" });
    })
  );
}
