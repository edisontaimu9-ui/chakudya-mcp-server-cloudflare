import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Part A: Estimation of Requirements for Adults — indication-based
 * energy/protein reference table (hospital dietetics guideline compiling
 * ASPEN, ESPEN, WHO, and other named-source recommendations by clinical
 * indication: General/Obese ICU, IBD, Acute Renal Failure, AKI/CKD, Acute
 * Pancreatitis, Crohn's Disease, Short Bowel Syndrome, General Surgery,
 * Liver Disease, Active TB, Guillain-Barré, Open Abdomen, and
 * Low/High-Output Fistula).
 *
 * Pure reference lookup — no calculation, no Chakudya API calls. Each
 * indication typically has MULTIPLE guideline-body entries that don't
 * always agree with each other (e.g. ASPEN vs ESPEN for the same
 * indication give different kcal/kg ranges) — this tool surfaces all of
 * them rather than picking one, since the source itself presents them as
 * parallel options across guideline bodies, not a single answer.
 *
 * One tool: indication_based_energy_protein_reference.
 */

const INDICATION_DISCLAIMER =
  "Reference lookup only, per hospital dietetics guideline 'Part A: Estimation of Requirements for " +
  "Adults' compiling ASPEN/ESPEN/WHO and other named-source recommendations. Multiple guideline " +
  "bodies are shown per indication where the source lists more than one — they can disagree with " +
  "each other; use clinical judgment to select the applicable one for your setting. Not a substitute " +
  "for individualized clinical assessment.";

interface GuidelineRow {
  source: string;
  energy: string;
  protein?: string;
}

interface IndicationEntry {
  key: string;
  label: string;
  rows: GuidelineRow[];
}

const TABLE: IndicationEntry[] = [
  {
    key: "general_icu",
    label: "General ICU",
    rows: [
      { source: "ASPEN 2016", energy: "25-30 kCal/kg", protein: "1.2-2 g/kg actual BW - higher in polytrauma and burns" },
      { source: "ESPEN EN 2006 (Initial / Recovery / Undernourished)", energy: "Initial: 20-25 kCal/kg/day; Recovery: 25-30 kCal/kg/day; Undernourished: 25-30 kCal/kg/day", protein: "ESPEN 2019: 1.3 g/kg" },
      { source: "ESPEN PN 2009", energy: "Start at 25 kCal/kg and increase to target over 2-3 days (no upper limit set)", protein: "1.3-1.5 g/kg IBW/day" },
    ],
  },
  {
    key: "general_obese_icu",
    label: "General Obese ICU",
    rows: [
      { source: "ASPEN 2016", energy: "11-14 kCal/kg actual body weight, or 22-25 kCal/kg IBW", protein: ">2 g/kg IBW for class I and II; >2.5 g/kg IBW for class III" },
    ],
  },
  {
    key: "obesity_and_ibd",
    label: "Obesity and Inflammatory Bowel Disease (IBD)",
    rows: [
      { source: "ESPEN 2022", energy: "Not specified in source", protein: "1.2-1.5 g/kg ABW/d for active disease and obesity; 0.8-1 g/kg ABW/d in remission" },
    ],
  },
  {
    key: "acute_renal_failure_icu",
    label: "Acute Renal Failure in ICU",
    rows: [
      { source: "ASPEN 2016", energy: "25-30 kcal/kg/day usual weight. If obese OR critically ill, use IBW", protein: "At least 1.5-2 g/kg. Up to 2.5 g/kg, especially if on TPN or CRRT" },
      { source: "ESPEN 2006", energy: "20-30 kCal NPE/kg/d (CHO: 3-5 g/kg/d, max 7) (fat: 0.8-1.2 g/kg/d, max 1.5)", protein: "Conservative 0.6-0.8 (max 1) g/kg/d; RRT 1-1.5 g/kg/d; CRRT 1.7 g/kg/d" },
      { source: "ESPEN PN 2009", energy: "130% of predicted energy expenditure, or 20-30 kCal NPE/kg/day", protein: "Conservative 0.6-0.8 (max 1) g/kg/d; RRT 1-1.5 g/kg/d; CRRT 1.7 g/kg/d" },
    ],
  },
  {
    key: "aki_ckd_renal_ward",
    label: "AKI/CKD in renal ward",
    rows: [
      { source: "ESPEN 2018", energy: "25-30 kCal/kg on a low protein diet; 30-35 kCal/kg not on a low protein diet" },
    ],
  },
  {
    key: "acute_pancreatitis",
    label: "Acute Pancreatitis",
    rows: [
      { source: "ESPEN Enteral 2002", energy: "25-35 kcal/kg/d (CHO 3-6 g/kg/d; BG <10 mmol/l) (fat up to 2 g/kg/d; TG <12 mmol/l)", protein: "1.2-1.5 g/kg/d" },
      { source: "ESPEN PN 2009", energy: "25-30 kcal NPE/kg per day; 15-20 kcal NPE/kg/d with refeeding risk; 15-20 kcal NPE/kg/d with SIRS or MODS", protein: "1.2-1.5 g/kg/day; 0.9-1.25 g/kg/d if renal or hepatic failure" },
    ],
  },
  {
    key: "crohns_disease",
    label: "Crohn's Disease",
    rows: [
      { source: "ESPEN EN 2006 and PN 2009", energy: "25-30 kCal/kg/day" },
    ],
  },
  {
    key: "short_bowel_syndrome",
    label: "Short Bowel Syndrome",
    rows: [
      { source: "ESPEN EN 2006", energy: "Up to 60 kCal/kg/day", protein: "1.5-2 g/kg/day" },
      { source: "ESPEN PN 2009", energy: "0.85-1.5 x REE; 25-33 kcal/kg/d post-operatively", protein: "1-1.5 g/kg/d" },
    ],
  },
  {
    key: "general_surgery",
    label: "General surgery",
    rows: [
      { source: "ESPEN PN 2009", energy: "25 kCal/kg IBW per day; 30 kCal/kg IBW per day with severe stress", protein: "1.5 g/kg IBW/day or 20% total energy" },
    ],
  },
  {
    key: "liver_disease",
    label: "Liver Disease",
    rows: [
      { source: "ESPEN EN 2006", energy: "35-40 kCal/kg/day", protein: "1.2-1.5 g/kg/day" },
      { source: "ESPEN PN 2009", energy: "1.3 x REE (CHO 50-60% NPE)", protein: "Cirrhosis and Alcoholic steatohepatitis: 1.2-1.5 g/kg/day; Acute liver failure: 0.8-1.2 g/kg/d" },
    ],
  },
  {
    key: "liver_failure_espen_consensus_1997",
    label: "Liver Failure (ESPEN Liver Consensus Statement, 1997) — by ascites/complication and disease stage",
    rows: [
      { source: "No ascites", energy: "1.2-1.4 x BEE" },
      { source: "If complications present", energy: "1.5-1.75 x BEE" },
      { source: "Compensated cirrhosis", energy: "25-35 kcal NPE/kg/day", protein: "1-1.2 g/kg/day" },
      { source: "ESLD with malnutrition", energy: "35-40 kcal NPE/kg/day", protein: "1.5 g/kg/day" },
      { source: "Encephalopathy I-II", energy: "25-35 kcal NPE/kg/day", protein: "Transiently 0.5, then 1-1.5 g/kg/day if protein tolerant (veg/BCAA) — very few patients" },
      { source: "Encephalopathy III-IV", energy: "25-35 kcal NPE/kg/day", protein: "0.5-1.2 g/kg/day; BCAAs in rare individual cases" },
    ],
  },
  {
    key: "active_tb",
    label: "Active TB",
    rows: [
      { source: "WHO 2003", energy: "35-40 kCal/kg IBW" },
    ],
  },
  {
    key: "guillain_barre",
    label: "Guillain-Barré",
    rows: [
      { source: "Roubenoff et al, 1992", energy: "40-45 kCal/kg NPE", protein: "2-2.5 g/kg" },
    ],
  },
  {
    key: "open_abdomen",
    label: "Open abdomen",
    rows: [
      { source: "Friese, 2012", energy: "25-35 kcal NPE/kg", protein: "1.5-2 g/kg + 29 g/l of effluent" },
    ],
  },
  {
    key: "low_output_fistula",
    label: "Low output fistula",
    rows: [
      { source: "Tong, 2012", energy: "25 kcal/kg TE", protein: "1-1.5 g/kg" },
    ],
  },
  {
    key: "high_output_fistula",
    label: "High output fistula",
    rows: [
      {
        source: "Tong 2012; ASPEN 2016",
        energy: "At least 30 kcal/kg TE",
        protein: "1.5-2 g/kg + 2 g/l of effluent. 2x DRI (up to 6x Vitamin C and Zinc). High risk of B12, Zn, Mg, Se deficiencies",
      },
    ],
  },
];

export function registerIndicationEnergyProteinTools(server: McpServer): void {
  server.registerTool(
    "indication_based_energy_protein_reference",
    {
      title: "Indication-Based Energy & Protein Requirement Reference",
      description:
        "Look up energy and protein requirement recommendations by clinical indication (e.g. General " +
        "ICU, Acute Renal Failure, Liver Disease, Short Bowel Syndrome, Open Abdomen, High/Low Output " +
        "Fistula) from a hospital dietetics guideline compiling ASPEN/ESPEN/WHO and other named " +
        "sources. Most indications have multiple guideline-body entries that can disagree with each " +
        "other — all are returned together rather than one being picked as 'the' answer. Omit " +
        "'indication' to get the list of available indications.",
      inputSchema: {
        indication: z
          .enum([
            "general_icu",
            "general_obese_icu",
            "obesity_and_ibd",
            "acute_renal_failure_icu",
            "aki_ckd_renal_ward",
            "acute_pancreatitis",
            "crohns_disease",
            "short_bowel_syndrome",
            "general_surgery",
            "liver_disease",
            "liver_failure_espen_consensus_1997",
            "active_tb",
            "guillain_barre",
            "open_abdomen",
            "low_output_fistula",
            "high_output_fistula",
          ])
          .optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("indication_based_energy_protein_reference", async ({ indication }) => {
      if (!indication) {
        return ok(
          { available_indications: TABLE.map((e) => ({ key: e.key, label: e.label })) },
          { disclaimer: INDICATION_DISCLAIMER }
        );
      }

      const entry = TABLE.find((e) => e.key === indication);
      if (!entry) {
        throw new Error(`No entry for indication "${indication}".`);
      }

      return ok(
        {
          indication: entry.label,
          guideline_recommendations: entry.rows,
        },
        { disclaimer: INDICATION_DISCLAIMER }
      );
    })
  );
}
