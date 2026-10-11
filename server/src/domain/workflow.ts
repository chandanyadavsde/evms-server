import type { FlowDefinition, StepDef } from '@vms/contracts';
import jsonLogic from 'json-logic-js';
import { isValidContainerNumber } from './container-number';
import { localize } from './i18n';
import { msg } from './messages';

/**
 * Workflow executor core: given a step, the leg context and what the user submitted,
 * decide whether the action is allowed and which step comes next.
 * Pure function — persistence and automations are handled by the caller.
 */

export interface StepContext {
  cargo?: Record<string, unknown>;
  client?: Record<string, unknown>;
  vehicle?: Record<string, unknown>;
  leg?: Record<string, unknown>;
  /** Values captured in earlier steps of this leg, by field key. */
  fields?: Record<string, unknown>;
}

export interface FieldError {
  field: string;
  message: string;
}

export type ActionResult =
  | { ok: true; nextStep: string | 'end'; automations: NonNullable<StepDef['onComplete']> }
  | { ok: false; errors: FieldError[] };

export function findStep(flow: FlowDefinition, key: string): StepDef {
  const step = flow.steps.find((s) => s.key === key);
  if (!step) throw new Error(`Step "${key}" not in flow "${flow.key}" v${flow.version}`);
  return step;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Field keys required for this step in this context (static + conditional). */
export function requiredFields(step: StepDef, ctx: StepContext): Set<string> {
  const required = new Set(step.fields.filter((f) => f.required).map((f) => f.key));
  for (const cond of step.conditions ?? []) {
    if (jsonLogic.apply(cond.if as jsonLogic.RulesLogic, ctx)) {
      for (const key of cond.require) required.add(key);
    }
  }
  return required;
}

export function validateStep(
  step: StepDef,
  ctx: StepContext,
  input: Record<string, unknown>,
  lang = 'en',
): FieldError[] {
  const errors: FieldError[] = [];
  const required = requiredFields(step, ctx);

  for (const field of step.fields) {
    const value = input[field.key];
    if (isEmpty(value)) {
      if (required.has(field.key))
        errors.push({ field: field.key, message: msg('required', lang) });
      continue;
    }
    if (field.type === 'number' && typeof value !== 'number') {
      errors.push({ field: field.key, message: msg('mustBeNumber', lang) });
      continue;
    }
    if (field.validate === 'container_number' && !isValidContainerNumber(String(value))) {
      errors.push({ field: field.key, message: msg('invalidContainer', lang) });
      continue;
    }
    if (field.rule !== undefined) {
      const passed = jsonLogic.apply(field.rule as jsonLogic.RulesLogic, {
        value,
        context: ctx,
        fields: { ...ctx.fields, ...input },
      });
      if (!passed) {
        const text = field.ruleMessage
          ? localize(field.ruleMessage, lang)
          : msg('invalidValue', lang);
        errors.push({ field: field.key, message: text });
      }
    }
  }
  return errors;
}

export function performAction(
  flow: FlowDefinition,
  stepKey: string,
  action: string,
  ctx: StepContext,
  input: Record<string, unknown>,
  lang = 'en',
): ActionResult {
  const step = findStep(flow, stepKey);
  const transition = step.transitions.find((t) => t.action === action);
  if (!transition) {
    return { ok: false, errors: [{ field: '_action', message: msg('actionNotAllowed', lang) }] };
  }
  if (!transition.skipValidation) {
    const errors = validateStep(step, ctx, input, lang);
    if (errors.length) return { ok: false, errors };
  }
  // A step's automations run only when it is actually left (not on "report issue" loops).
  const leaving = transition.to !== step.key;
  return { ok: true, nextStep: transition.to, automations: leaving ? (step.onComplete ?? []) : [] };
}

/** 1-based position of a step in the flow, for progress display. */
export function stepPosition(flow: FlowDefinition, key: string | null): number {
  if (!key) return flow.steps.length;
  return flow.steps.findIndex((s) => s.key === key) + 1;
}
