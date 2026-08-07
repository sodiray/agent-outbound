/**
 * Deterministic economic scenarios used as generated product output.
 */

export type EconomicScenarioInput = {
  scenario_id: string;
  weekly_admin_hours?: number | null;
  hourly_loaded_cost?: number | null;
  missed_leads_per_month?: number | null;
  avg_job_value?: number | null;
  close_rate?: number | null;
};

export type EconomicScenarioResult = {
  scenario_id: string;
  annual_low_usd: number | null;
  annual_high_usd: number | null;
  assumptions: string[];
  missing_inputs: string[];
  evidence_status: 'calculated' | 'insufficient';
  calculation_rule_version: string;
};

export const ECONOMIC_RULE_VERSION = 'tv-economics-v1';

export const calculateEconomicScenario = (input: EconomicScenarioInput): EconomicScenarioResult => {
  const assumptions: string[] = [];
  const missing: string[] = [];

  if (input.scenario_id === 'admin_labor_leak') {
    const hours = input.weekly_admin_hours;
    const rate = input.hourly_loaded_cost ?? 35;
    if (hours == null) {
      missing.push('weekly_admin_hours');
      return {
        scenario_id: input.scenario_id,
        annual_low_usd: null,
        annual_high_usd: null,
        assumptions,
        missing_inputs: missing,
        evidence_status: 'insufficient',
        calculation_rule_version: ECONOMIC_RULE_VERSION,
      };
    }
    assumptions.push(`hourly_loaded_cost_default_or_input=${rate}`);
    assumptions.push('weeks_per_year=48');
    const mid = hours * rate * 48;
    return {
      scenario_id: input.scenario_id,
      annual_low_usd: Math.round(mid * 0.7),
      annual_high_usd: Math.round(mid * 1.3),
      assumptions,
      missing_inputs: missing,
      evidence_status: 'calculated',
      calculation_rule_version: ECONOMIC_RULE_VERSION,
    };
  }

  if (input.scenario_id === 'missed_lead_revenue') {
    const leads = input.missed_leads_per_month;
    const job = input.avg_job_value;
    const close = input.close_rate ?? 0.25;
    if (leads == null || job == null) {
      if (leads == null) missing.push('missed_leads_per_month');
      if (job == null) missing.push('avg_job_value');
      return {
        scenario_id: input.scenario_id,
        annual_low_usd: null,
        annual_high_usd: null,
        assumptions,
        missing_inputs: missing,
        evidence_status: 'insufficient',
        calculation_rule_version: ECONOMIC_RULE_VERSION,
      };
    }
    assumptions.push(`close_rate=${close}`);
    const mid = leads * 12 * job * close;
    return {
      scenario_id: input.scenario_id,
      annual_low_usd: Math.round(mid * 0.6),
      annual_high_usd: Math.round(mid * 1.4),
      assumptions,
      missing_inputs: missing,
      evidence_status: 'calculated',
      calculation_rule_version: ECONOMIC_RULE_VERSION,
    };
  }

  missing.push('unknown_scenario_id');
  return {
    scenario_id: input.scenario_id,
    annual_low_usd: null,
    annual_high_usd: null,
    assumptions,
    missing_inputs: missing,
    evidence_status: 'insufficient',
    calculation_rule_version: ECONOMIC_RULE_VERSION,
  };
};
