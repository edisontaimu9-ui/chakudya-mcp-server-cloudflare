import { describe, it, expect } from "vitest";
import { integratedPregnantPostpartumScreen } from "../pregnantPostpartumScreeningTools.js";

describe("integratedPregnantPostpartumScreen — validation", () => {
  it("errors when no indicator is provided", () => {
    const r = integratedPregnantPostpartumScreen({});
    expect(r.ok).toBe(false);
  });
});

describe("integratedPregnantPostpartumScreen — classification boundaries", () => {
  it("classifies MUAC just below the severe cutoff (189mm) as severe -> urgent", () => {
    const r = integratedPregnantPostpartumScreen({ muac_mm: 189 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.classification.overallMalnutritionClassification).toBe("severe");
    expect(r.result.recommended_action.urgency).toBe("urgent");
  });

  it("classifies MUAC at the severe/moderate boundary (190mm) as moderate -> priority", () => {
    const r = integratedPregnantPostpartumScreen({ muac_mm: 190 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.classification.overallMalnutritionClassification).toBe("moderate");
    expect(r.result.recommended_action.urgency).toBe("priority");
  });

  it("classifies MUAC at the default moderate/normal boundary (220mm) as normal -> routine", () => {
    const r = integratedPregnantPostpartumScreen({ muac_mm: 220 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.classification.overallMalnutritionClassification).toBe("normal");
    expect(r.result.recommended_action.urgency).toBe("routine");
  });

  it("respects a 230mm country-specific moderate/normal boundary", () => {
    const at220 = integratedPregnantPostpartumScreen({ muac_mm: 225, moderate_muac_upper_mm: 230 });
    const default220 = integratedPregnantPostpartumScreen({ muac_mm: 225 });
    expect(at220.ok && at220.result.classification.overallMalnutritionClassification).toBe("moderate");
    expect(default220.ok && default220.result.classification.overallMalnutritionClassification).toBe("normal");
  });

  it("treats any oedema as severe -> urgent regardless of MUAC", () => {
    const r = integratedPregnantPostpartumScreen({ edema: true, muac_mm: 240 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.classification.overallMalnutritionClassification).toBe("severe");
    expect(r.result.recommended_action.urgency).toBe("urgent");
  });

  it("treats confirmed >10% weight loss as severe -> urgent regardless of MUAC", () => {
    const r = integratedPregnantPostpartumScreen({ confirmed_weight_loss_over_10_percent: true, muac_mm: 240 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.classification.overallMalnutritionClassification).toBe("severe");
    expect(r.result.recommended_action.urgency).toBe("urgent");
  });

  it("classifies fully normal indicators as routine with no flags beyond missing fields", () => {
    const r = integratedPregnantPostpartumScreen({ edema: false, muac_mm: 250, confirmed_weight_loss_over_10_percent: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.recommended_action.urgency).toBe("routine");
    expect(r.result.clinical_flags.some((f) => f.flag.startsWith("nacs_"))).toBe(false);
    expect(r.result.clinical_flags.some((f) => f.flag.startsWith("missing_measurement"))).toBe(false);
  });
});

describe("integratedPregnantPostpartumScreen — missing data is flagged, never invented", () => {
  it("flags unprovided fields explicitly", () => {
    const r = integratedPregnantPostpartumScreen({ muac_mm: 240 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.clinical_flags.some((f) => f.flag === "missing_measurement:edema")).toBe(true);
    expect(r.result.clinical_flags.some((f) => f.flag === "missing_measurement:confirmed_weight_loss_over_10_percent")).toBe(true);
  });
});

describe("integratedPregnantPostpartumScreen — output shape", () => {
  it("includes the Malawi-protocol TODO and limitations", () => {
    const r = integratedPregnantPostpartumScreen({ muac_mm: 180 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.referral.todo_malawi_protocol).toMatch(/TODO/);
    expect(r.result.limitations.length).toBeGreaterThan(0);
    expect(r.result.explanation).toMatch(/muac/);
  });
});
