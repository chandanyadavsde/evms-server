import type { FlowDefinition } from '@vms/contracts';

/**
 * Structural checks a JSON schema can't express: references between steps and fields.
 * Run before a flow is published (and in tests for every file in config/flows).
 */
export function lintFlow(flow: FlowDefinition): string[] {
  const errors: string[] = [];
  const stepKeys = new Set<string>();

  for (const step of flow.steps) {
    if (stepKeys.has(step.key)) errors.push(`duplicate step "${step.key}"`);
    stepKeys.add(step.key);
  }
  if (!stepKeys.has(flow.initialStep)) {
    errors.push(`initialStep "${flow.initialStep}" is not a step`);
  }

  for (const step of flow.steps) {
    const fieldKeys = new Set<string>();
    for (const field of step.fields) {
      if (fieldKeys.has(field.key)) errors.push(`${step.key}: duplicate field "${field.key}"`);
      fieldKeys.add(field.key);
      if (field.type === 'select' && !field.options?.length) {
        errors.push(`${step.key}.${field.key}: select needs options`);
      }
      if (field.type === 'document' && !field.docType) {
        errors.push(`${step.key}.${field.key}: document needs docType`);
      }
    }
    for (const cond of step.conditions ?? []) {
      for (const key of cond.require) {
        if (!fieldKeys.has(key))
          errors.push(`${step.key}: condition requires unknown field "${key}"`);
      }
    }
    for (const t of step.transitions) {
      if (t.to !== 'end' && !stepKeys.has(t.to)) {
        errors.push(`${step.key}.${t.action}: transition to unknown step "${t.to}"`);
      }
    }
  }

  const reachesEnd = flow.steps.some((s) => s.transitions.some((t) => t.to === 'end'));
  if (!reachesEnd) errors.push('no transition reaches "end"');

  return errors;
}
