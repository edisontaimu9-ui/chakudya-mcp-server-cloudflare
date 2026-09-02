import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Part A: Estimation of Requirements for Adults — indication-based
 * energy/protein reference table, merged from two source guidelines:
 * (1) a hospital dietetics guideline compiling ASPEN, ESPEN, WHO, and other
 * named-source recommendations (General/Obese ICU, IBD, Acute Renal
 * Failure, AKI/CKD, Acute Pancreatitis, Crohn's Disease, Short Bowel
 * Syndrome, General Surgery, Liver Disease, Active TB, Guillain-Barré,
 * Open Abdomen, Low/High-Output Fistula), and (2) an interns' nutrition
 * requirements compilation adding further indications (Burns, Cancer,
 * COPD/BPD, Cystic Fibrosis, CKD staging, Cardiovascular Disease,
 * TBI/SCI/CP, Dementia/Epilepsy/Stroke, GIT conditions, AIDS/HIV, Organ
 * Transplant/BMT, MS, Parkinson's/MND, Liver conditions, Metabolic
 * conditions, Thyroid Disease, Pressure Ulcer, Bariatric Surgery) and
 * additional rows for indications already present in (1).
 *
 * Pure reference lookup — no calculation, no Chakudya API calls. Each
 * indication typically has MULTIPLE guideline-body entries that don't
 * always agree with each other (e.g. ASPEN vs ESPEN for the same
 * indication give different kcal/kg ranges) — this tool surfaces all of
 * them rather than picking one, since the sources themselves present them
 * as parallel options across guideline bodies, not a single answer. Rows
 * added from the interns' compilation are tagged "(Interns Compilation)"
 * in their source field so the two guideline sources stay distinguishable.
 *
 * One tool: indication_based_energy_protein_reference.
 */

const INDICATION_DISCLAIMER =
  "Reference lookup only, merged from a hospital dietetics guideline ('Part A: Estimation of " +
  "Requirements for Adults') and an interns' nutrition requirements compilation, both compiling " +
  "ASPEN/ESPEN/WHO/KDIGO/Krause's and other named-source recommendations. Multiple guideline bodies " +
  "are shown per indication where a source lists more than one — they can disagree with each other; " +
  "use clinical judgment to select the applicable one for your setting. Not a substitute for " +
  "individualized clinical assessment.";

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
      { source: "Critically ill — quick BMI method (Interns Compilation, ASPEN)", energy: "BMI <15: 30-40; 15-19: 30-35; 20-29: 20-25; \u226530: 14-20; 30-50: 11-14 kcal/kg; BMI >50: 22-25 kcal/kg IBW" },
      { source: "Critically ill pediatric — Schofield equation, boys (Interns Compilation, ASPEN, best choice)", energy: "<3y: (0.167\u00d7W)+(1517.4\u00d7H)-616.6; 3-10y: (19.59\u00d7W)+(130.3\u00d7H)+414.9; 10-18y: (16.25\u00d7W)+(137.2\u00d7H)+515.5" },
      { source: "Critically ill pediatric — Schofield equation, girls (Interns Compilation, ASPEN)", energy: "<3y: (16.252\u00d7W)+(1023.3\u00d7H)-413.5; 3-10y: (16.969\u00d7W)+(161.8\u00d7H)+371.2; 10-18y: (8.365\u00d7W)+(465\u00d7H)+200.0" },
      { source: "Critically ill pediatric protein by age (Interns Compilation, ASPEN)", protein: "0-2y: 2-3 g/kg/day; 2-13y: 1.5-2 g/kg/day; 13-18y: 1.5 g/kg/day" },
    ],
  },
  {
    key: "general_obese_icu",
    label: "General Obese ICU",
    rows: [
      { source: "ASPEN 2016", energy: "11-14 kCal/kg actual body weight, or 22-25 kCal/kg IBW", protein: ">2 g/kg IBW for class I and II; >2.5 g/kg IBW for class III" },
      { source: "Critically ill adult protein — normal BW (Interns Compilation, ASPEN)", protein: "1.2-2 g/kg/day" },
      { source: "Critically ill adult protein — obese, IBW-based (Interns Compilation, ASPEN)", protein: "2-2.5 g/kg/day" },
      { source: "Critically ill adult protein — adjusted BW (Interns Compilation, ESPEN)", protein: "1.3 g/kg/day (>1 g/kg/day)" },
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
      { source: "KDIGO (Interns Compilation)", energy: "20-30 kcal/kg/day, any stage of AKI", protein: "Not on dialysis: 0.8-1.0 g/kg/d; on HD/PD: 1.0-1.5 g/kg/d; on CRRT: 1.7 g/kg/d" },
      { source: "Fluid note — not on dialysis (Interns Compilation)", energy: "500 ml + previous day's output; restriction not required on dialysis" },
    ],
  },
  {
    key: "aki_ckd_renal_ward",
    label: "AKI/CKD in renal ward",
    rows: [
      { source: "ESPEN 2018", energy: "25-30 kCal/kg on a low protein diet; 30-35 kCal/kg not on a low protein diet" },
      { source: "CKD, all stages, on or not on dialysis — by age (Interns Compilation, essential pocket guideline)", energy: ">60 yrs: 30-35 kcal/kg/day; <60 yrs: 35 kcal/kg/day" },
      { source: "CKD stage 1-3 protein (Interns Compilation)", protein: "Up to 0.8-1.0 g/kg/day" },
      { source: "CKD stage 4-5, nondialyzed, GFR 25 mL/min (Interns Compilation)", protein: "Reduce protein to 10% of calories/day; use 0.6 g protein/kg/d" },
      { source: "CKD — hemodialysis (Interns Compilation)", protein: "1.2 g/kg/day" },
      { source: "CKD — peritoneal dialysis (Interns Compilation)", protein: "1.2-1.3 g/kg/day" },
      { source: "Note — body weight in CKD (Interns Compilation)", energy: "Adjusted body weight (aBWef) recommended over actual BW; use post-dialysis weight for HD, post-drain weight for PD, to account for fluid retention" },
    ],
  },
  {
    key: "acute_pancreatitis",
    label: "Acute Pancreatitis",
    rows: [
      { source: "ESPEN Enteral 2002", energy: "25-35 kcal/kg/d (CHO 3-6 g/kg/d; BG <10 mmol/l) (fat up to 2 g/kg/d; TG <12 mmol/l)", protein: "1.2-1.5 g/kg/d" },
      { source: "ESPEN PN 2009", energy: "25-30 kcal NPE/kg per day; 15-20 kcal NPE/kg/d with refeeding risk; 15-20 kcal NPE/kg/d with SIRS or MODS", protein: "1.2-1.5 g/kg/day; 0.9-1.25 g/kg/d if renal or hepatic failure" },
      { source: "Acute pancreatitis (Interns Compilation, ESPEN)", energy: "25-35 kcal/kg/day", protein: "1.2-1.5 g/kg/day" },
      { source: "Acute pancreatitis (Botelho, L. 2024)", energy: "EE can be 139% of Harris-Benedict estimate", protein: "1.2-1.5 g/kg/day (Lakananurak & Gramlich); nitrogen loss ~20-40 g/day" },
    ],
  },
  {
    key: "crohns_disease",
    label: "Crohn's Disease",
    rows: [
      { source: "ESPEN EN 2006 and PN 2009", energy: "25-30 kCal/kg/day" },
      { source: "IBD active/remission (Interns Compilation, ESPEN 2023)", energy: "30-35 kcal/kg", protein: "1.2-1.5 g/kg/day (active and remission)" },
    ],
  },
  {
    key: "short_bowel_syndrome",
    label: "Short Bowel Syndrome",
    rows: [
      { source: "ESPEN EN 2006", energy: "Up to 60 kCal/kg/day", protein: "1.5-2 g/kg/day" },
      { source: "ESPEN PN 2009", energy: "0.85-1.5 x REE; 25-33 kcal/kg/d post-operatively", protein: "1-1.5 g/kg/d" },
      { source: "Interns Compilation", energy: "30-35 kcal/kg", protein: "1.5-2.5 g/kg/day if well nourished; 2.5 g/kg/day if malnourished" },
    ],
  },
  {
    key: "diverticular_pu_pancreatic_insufficiency",
    label: "Diverticular Disease, Peptic Ulcer, Pancreatic Insufficiency",
    rows: [
      { source: "Diverticular disease — acute phase (Interns Compilation)", energy: "NPO or clear liquid diet; 25-30 kcal/kg once tolerated" },
      { source: "Diverticular disease — remission (Interns Compilation)", energy: "25-30 kcal/kg", protein: "1.0-1.2 g/kg/day; increase fiber gradually to 25-30 g/day" },
      { source: "Peptic ulcer (Interns Compilation)", energy: "Normal calorie distribution: 50-60% CHO, 10-15% protein, 25-30% fat" },
      { source: "Peptic ulcer protein — acute stage, 5th-8th week (Interns Compilation)", protein: "Up to 1.2 g/kg/day" },
      { source: "Peptic ulcer protein — recovery stage (Interns Compilation)", protein: "Up to 1.5 g/kg/day" },
      { source: "Pancreatic insufficiency (Interns Compilation)", energy: "25-35 kcal/kg/day" },
      { source: "Pancreatic insufficiency protein — mild/moderate chronic pancreatitis (Interns Compilation)", protein: "1.5-2 g/kg/day; protein need depends on cause and severity" },
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
      { source: "Hepatitis (Interns Compilation)", energy: "25-30 kcal/kg/day" },
      { source: "Cirrhosis, based on dry weight (Interns Compilation)", energy: "25-30 kcal/kg/day", protein: "1.2-1.4 kcal/kg x REE for total energy intake" },
      { source: "Hepatic encephalopathy (Interns Compilation)", energy: "35-40 kcal/kg/day", protein: "1.2-1.5 g/kg/day" },
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
      { source: "Harris-Benedict x stress factor (Interns Compilation, ASPEN)", energy: "BEE x stress factor 1.3-1.5" },
      { source: "Ideal body weight method (Interns Compilation, WHO)", energy: "35-40 kcal/kg IBW, for hypercatabolic/undernourished patients", protein: "1.2-1.5 g/kg/day (WHO)" },
      { source: "Note — calorie calculation (Interns Compilation)", energy: "Recommended using dry weight; gradually increase 10-20% up to total energy needs over 7 days" },
    ],
  },
  {
    key: "burn_patient",
    label: "Burn Patient",
    rows: [
      { source: "Harris-Benedict (BEE x stress factor)", energy: "Standard Harris-Benedict equation with burn stress factor" },
      { source: "Curreri formula, Adult (ASPEN)", energy: "(40 x wt) + (25 x %TBSA)" },
      { source: "Curreri formula, Children (ASPEN)", energy: "(60 x wt) + (35 x %TBSA)" },
      { source: "Quick method by burn classification", energy: "Minor burn: 25-30 kcal/kg; Major burn: 30-40 kcal/kg; TBSA >40%: use >40 kcal/kg" },
      { source: "ASPEN, Adult protein", protein: "1.5-2 g/kg/day" },
      { source: "ASPEN, Pediatric protein", protein: "2.5-4 g/kg/day" },
      { source: "Alternative method", protein: "%TBSA may also be used to calculate protein requirements" },
      { source: "Note", energy: "Consider fluid/electrolyte fluctuations" },
    ],
  },
  {
    key: "cancer_patient",
    label: "Cancer Patient",
    rows: [
      { source: "Mifflin-St Jeor x stress factor", energy: "Apply stress factor to Mifflin-St Jeor equation" },
      { source: "Quick method — Sedentary", energy: "25-30 kcal/kg" },
      { source: "Quick method — Slightly hypermetabolic", energy: "30-35 kcal/kg" },
      { source: "Quick method — Stressed with malabsorption", energy: "30+ kcal/kg" },
      { source: "Quick method — Obese", energy: "21-25 kcal/kg" },
      { source: "General", protein: "1.2-1.5 g/kg/day; nutrition plan depends on organ affected" },
    ],
  },
  {
    key: "copd_bpd",
    label: "Lung Disease — COPD, Bronchopulmonary Dysplasia (BPD)",
    rows: [
      { source: "BPD, infants", energy: "15-25% higher than normal; ~120-130 kcal/kg often required for growth; up to 150 kcal/kg in some cases" },
      { source: "COPD, adults", energy: "30-45 kcal/kg/day" },
      { source: "COPD/BPD, alternative", energy: "125-156% (avg 140%) above basal energy expenditure, or 25-30 kcal/kg" },
      { source: "COPD, infant protein", protein: "3-4 g/kg/day" },
      { source: "COPD, adult protein", protein: "1.2-1.5 g/kg/day" },
      { source: "BPD protein", protein: "1.2-1.7 g/kg/day (average 1.2 g/kg)" },
      { source: "Note — lung failure", energy: "Consider omega-3 and omega-6" },
      { source: "Note — BPD", energy: "Primary concern is overfeeding (risk of hypercapnia), not carbohydrate load per se" },
    ],
  },
  {
    key: "cystic_fibrosis",
    label: "Cystic Fibrosis",
    rows: [
      { source: "General", energy: "110-200% of RDA for age" },
      { source: "Adults", energy: "1.2-1.5 x DRI for age" },
      { source: "Quick estimate, Females", energy: "30-35 kcal/kg" },
      { source: "Quick estimate, Males", energy: "35-40 kcal/kg" },
      { source: "During infection or weight loss", energy: "Up to 45-50 kcal/kg" },
      { source: "Teens, severe cases", energy: "May need 3000-4000 kcal/day (120-150% more than age/gender-matched controls); EE up to 199% of predicted" },
      { source: "Adults protein", protein: "20% of total calories, or 1.5-2 x DRI for age" },
      { source: "Children protein", protein: "1.2-2 x DRI for age" },
      { source: "Protein by age, alternative", protein: "10-35% of total calories: ~4 g/kg infants, 3 g/kg children, 2 g/kg teens, 1.5 g/kg adults" },
    ],
  },
  {
    key: "cv_disease",
    label: "Cardiovascular Disease — Atherosclerosis, HTN, Heart Failure, IHD",
    rows: [
      { source: "General, quick BMI method, adults (ASPEN)", energy: "BMI <15: 30-40; 15-19: 30-35; 20-29: 20-25; \u226530: 14-20; 30-50: 11-14 kcal/kg; BMI >50: 22-25 kcal/kg IBW" },
      { source: "Pediatric (DRI), infants/toddlers", energy: "0-6mo: 108; 6-12mo: 98; 1-3y: 102; 4-6y: 90; 7-10y: 70 kcal/kg" },
      { source: "Pediatric (DRI), boys", energy: "11-14y: 55; 15-18y: 45 kcal/kg" },
      { source: "Pediatric (DRI), girls", energy: "11-14y: 47; 15-18y: 40 kcal/kg" },
      { source: "Adults, normal BW (ASPEN)", protein: "1.2-2 g/kg/day" },
      { source: "Adults, obese, IBW-based (ASPEN)", protein: "2-2.5 g/kg/day" },
      { source: "Pediatric protein (DRI), infants/toddlers", protein: "0-6mo: 2.2; 6-12mo: 1.6; 1-3y: 1.2; 4-6y: 1.1; 7-10y: 1.0 g/kg" },
      { source: "Pediatric protein (DRI), boys/girls 11-14y", protein: "1.0 g/kg" },
      { source: "Pediatric protein (DRI), boys 15-18y", protein: "0.9 g/kg" },
      { source: "Pediatric protein (DRI), girls 15-18y", protein: "0.8 g/kg" },
      { source: "Heart failure, newer recommendation", energy: "22-24 kcal/kg; +3-7 kcal/kg in advanced stages", protein: "1.2-1.5 g/kg unless AKI present" },
      { source: "Note — atherosclerosis risk", energy: "Keep protein \u226422% of total calories to reduce atherosclerosis risk" },
    ],
  },
  {
    key: "cns_tbi_sci_cp",
    label: "CNS Disease — TBI, SCI, Cerebral Palsy",
    rows: [
      { source: "TBI, Penn State equation", energy: "1.25 factor, or 120-160% above BMR (Harris-Benedict) using ABW" },
      { source: "TBI, obese/non-obese <60y (Mifflin-based RMR)", energy: "RMR = Mifflin(0.96) + VE(1) + Tmax(167) - 6.212" },
      { source: "TBI, obese >60y (Mifflin-based RMR)", energy: "RMR = Mifflin(0.71) + VE(64) + Tmax(85) - 3.085" },
      { source: "SCI, acute phase", energy: "Ireton-Jones and Owen equation; 1.2 injury factor, 1.1 activity factor" },
      { source: "SCI, rehabilitation, quadriplegic", energy: "22.7 kcal/kg" },
      { source: "SCI, rehabilitation, paraplegic", energy: "27.9 kcal/kg; assess for pressure ulcer and increase if needed" },
      { source: "SCI, alternative method", energy: "Harris-Benedict x1.6 (injury) and x1.2 (activity)" },
      { source: "SCI, chronic/long-term setting", energy: "20-23 kcal/kg" },
      { source: "TBI protein", protein: "1.5-2.0 g/kg/day" },
      { source: "SCI protein, acute phase", protein: "2.0 g/kg/day" },
      { source: "SCI protein, rehabilitation/long-term", protein: "0.8-1.0 g/kg/day" },
      { source: "CP protein, 1-3y", protein: "1.2-1.5 g/kg/day" },
      { source: "CP protein, 4-8y", protein: "1.0-1.5 g/kg/day" },
      { source: "CP protein, 9-13y / 14-18y", protein: "1.0-1.5 g/kg/day" },
      { source: "CP protein, 19-50y / >51y", protein: "1.0-1.2 g/kg/day" },
      { source: "Note", energy: "Use IC (indirect calorimetry) as gold standard if possible, ~140% of EER otherwise; obese patients calculated on IBW; TBI target BMI 22-27 kg/m2; wheelchair type in SCI affects requirements" },
    ],
  },
  {
    key: "dementia_epilepsy_stroke",
    label: "Dementia, Epilepsy/Seizures, Stroke",
    rows: [
      { source: "Ambulatory (upper body movement preserved)", energy: "Use Harris-Benedict equation" },
      { source: "Bedridden, general recommendation", energy: "25-30 kcal/kg" },
      { source: "Pediatric 5-11y, ambulatory", energy: "14 kcal/cm" },
      { source: "Pediatric 5-11y, non-ambulatory", energy: "11 kcal/cm" },
      { source: "Pediatric, mild activity", energy: "13.9 kcal/cm" },
      { source: "Pediatric, severe physical restriction", energy: "11.1 kcal/cm" },
      { source: "Athetoid cerebral palsy", energy: "Up to 6000 kcal/day" },
      { source: "Dementia / Epilepsy / Stroke", energy: "Follow general recommendation" },
      { source: "Ketogenic diet (epilepsy)", protein: "1.5-2.0 g/kg/day" },
      { source: "Fluid recommendation", energy: "1 ml/kcal + 500 ml, or 400 ml/kg + 500 ml daily" },
      { source: "Fiber (neurogenic bowel)", energy: "15 g/day, slowly increased to 30 g/day" },
    ],
  },
  {
    key: "aids_hiv",
    label: "AIDS / HIV",
    rows: [
      { source: "Adults, asymptomatic HIV", energy: "Increase by 10% to maintain body weight and activity" },
      { source: "Adults, symptomatic HIV", energy: "Increase by 20-30% to maintain body weight" },
      { source: "Children, asymptomatic HIV", energy: "Increase by 10% to maintain growth" },
      { source: "Children, experiencing weight loss", energy: "Increase by 50-100% over normal requirements" },
      { source: "Adults, asymptomatic/stable (ESPEN)", protein: "1.2 g/kg/day" },
      { source: "Adults, symptomatic/acute illness (ESPEN)", protein: "1.5 g/kg/day" },
      { source: "Adults, general recommendation (Kraus)", protein: "1.6-1.8 g/kg" },
      { source: "Children (WHO)", protein: "12-15% of total energy intake" },
    ],
  },
  {
    key: "organ_transplant_bmt",
    label: "Organ Transplantation / Bone Marrow Transplant",
    rows: [
      { source: "Acute post-transplant phase", energy: "35 kcal/kg" },
      { source: "Chronic post-transplant, on high-dose steroids", energy: "30-35 kcal/kg BW" },
      { source: "Chronic post-transplant, after steroids", energy: "Kcal to achieve IBW" },
      { source: "Bone marrow transplant (BMT)", energy: "35 kcal/kg body weight" },
      { source: "Acute post-transplant protein", protein: "1.5-2.0 g/kg/day" },
      { source: "Chronic, on high-dose steroids protein", protein: "1.5-2 g/kg BW" },
      { source: "Chronic, after steroids protein", protein: "1 g/kg BW" },
      { source: "BMT protein", protein: "1.4-1.5 g/kg/day" },
    ],
  },
  {
    key: "multiple_sclerosis",
    label: "Multiple Sclerosis",
    rows: [
      { source: "Quick method (avoid excessive intake to minimize obesity risk)", energy: "25-30 kcal/kg", protein: "Normal protein for age" },
    ],
  },
  {
    key: "parkinsons_mnd",
    label: "Parkinson's Disease / Motor Neurone Disease (ALS)",
    rows: [
      { source: "Parkinson's, most patients (NCM 2023)", energy: "25-30 kcal/kg/day" },
      { source: "Parkinson's, underweight/increased activity/severe dyskinesia", energy: "30-35 kcal/kg/day" },
      { source: "Parkinson's, limited mobility/overweight", energy: "20-25 kcal/kg/day" },
      { source: "MND/ALS", energy: "25-30 kcal/kg" },
      { source: "Parkinson's protein", protein: "1.2-1.5 g/kg/day" },
      { source: "MND/ALS protein", protein: "0.8-1.5 g/kg/day" },
      { source: "MND, fluid/thickening", energy: "2-3 L water daily; thicken liquids as needed with commercial thickeners" },
    ],
  },
  {
    key: "metabolic_gout_dm_pku_obesity_pcos",
    label: "Gout, Diabetes, PKU, Malnutrition/Obesity, PCOS",
    rows: [
      { source: "Gout", energy: "Moderate calorie intake", protein: "1 g/kg/day" },
      { source: "Diabetes, general quick method", energy: "25-30 kcal/kg/day", protein: "1-1.5 g/kg BW/day, or 10-20% total energy" },
      { source: "PKU", energy: "Follow PKU-specific nutrition guidelines (specialist protocol)" },
      { source: "Obesity, Krause's typical", energy: "25-30 kcal/kg with 500-1000 kcal/day deficit for ~0.5-1 kg/week loss", protein: "1.2-1.5 g/kg adjusted BW/day" },
      { source: "Obesity, Krause's alternative", energy: "1200-1500 kcal/day (women), 1500-1800 kcal/day (men), individualized" },
      { source: "Undernutrition (Krause's)", energy: "30-40 kcal/kg/day depending on severity/stress", protein: "1.2-2.0 g/kg/day to replete lean body mass" },
      { source: "PCOS (Krause's)", energy: "Individualized based on weight goals, insulin resistance, metabolic status; weight loss: 500-750 kcal/day deficit (target ~1200-1500 kcal/day)", protein: "1.0-1.5 g/kg actual BW/day" },
      { source: "Note — adjusted body weight (obesity)", energy: "ABW = IBW + 0.25 x (Actual BW - IBW)" },
    ],
  },
  {
    key: "thyroid_disease",
    label: "Thyroid Disease — Hypothyroidism / Hyperthyroidism",
    rows: [
      { source: "Hypothyroidism (Krause's)", energy: "~20-25 kcal/kg/day, individualized", protein: "~0.8-1 g/kg/day (normal unless complications)" },
      { source: "Hyperthyroidism (Krause's)", energy: "~30-40 kcal/kg/day or more", protein: "~1.2-1.5 g/kg/day (increased to prevent muscle wasting)" },
    ],
  },
  {
    key: "pressure_ulcer",
    label: "Pressure Ulcer",
    rows: [
      { source: "General", energy: "30-35 kcal/kg" },
      { source: "Underweight or losing weight", energy: "35-40 kcal/kg/day" },
      { source: "General protein", protein: "1.25-1.5 g/kg of high-biological-value protein" },
      { source: "Stage II", protein: "1.2-1.5 g/kg/day" },
      { source: "Stage III/IV", protein: "1.5-2.0 g/kg/day" },
      { source: "Fluid", energy: "30-35 ml/kg actual BW, minimum 1500 ml/day" },
      { source: "Note — Vitamin C caution (renal failure with pressure ulcer)", energy: "No more than 60-100 mg/day to avoid kidney stones" },
    ],
  },
  {
    key: "bariatric_surgery",
    label: "Bariatric Surgery",
    rows: [
      { source: "Mifflin-St Jeor using ABW", energy: "Standard equation with adjusted body weight" },
      { source: "Alternative", protein: "1.5 g/kg/day IBW" },
      { source: "Early post-op, first month (NCM 2023)", energy: "300-600 kcal/day depending on tolerance" },
      { source: "Weight loss phase, first 6-12 months", energy: "800-1200 kcal/day" },
      { source: "Long-term maintenance", energy: "1200-1500 kcal/day depending on activity/goals/surgery type" },
      { source: "Note — malabsorption (RYGB, BPD)", energy: "Supplement multivitamin+iron, calcium citrate+vitamin D, B12, iron/folate, zinc/thiamine as needed" },
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
        "Fistula, Burns, Cancer, COPD/BPD, Cystic Fibrosis, CKD, Cardiovascular Disease, TBI/SCI/CP, " +
        "Dementia/Epilepsy/Stroke, AIDS/HIV, Organ Transplant/BMT, MS, Parkinson's/MND, Thyroid " +
        "Disease, Pressure Ulcer, Bariatric Surgery, Gout/Diabetes/PKU/Obesity/PCOS) compiled from a " +
        "hospital dietetics guideline and an interns' nutrition requirements compilation, both citing " +
        "ASPEN/ESPEN/WHO/KDIGO/Krause's and other named sources. Most indications have multiple " +
        "guideline-body entries that can disagree with each other — all are returned together rather " +
        "than one being picked as 'the' answer. Omit 'indication' to get the list of available " +
        "indications.",
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
            "diverticular_pu_pancreatic_insufficiency",
            "general_surgery",
            "liver_disease",
            "liver_failure_espen_consensus_1997",
            "active_tb",
            "guillain_barre",
            "open_abdomen",
            "low_output_fistula",
            "high_output_fistula",
            "burn_patient",
            "cancer_patient",
            "copd_bpd",
            "cystic_fibrosis",
            "cv_disease",
            "cns_tbi_sci_cp",
            "dementia_epilepsy_stroke",
            "aids_hiv",
            "organ_transplant_bmt",
            "multiple_sclerosis",
            "parkinsons_mnd",
            "metabolic_gout_dm_pku_obesity_pcos",
            "thyroid_disease",
            "pressure_ulcer",
            "bariatric_surgery",
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
