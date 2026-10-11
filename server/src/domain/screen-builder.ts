import type { Component, Screen, StepDef } from '@vms/contracts';
import { localize } from './i18n';
import { requiredFields, type StepContext } from './workflow';

export { localize };

/** Turns a configured step into the Screen JSON that React / Flutter render. */

export interface ScreenInput {
  step: StepDef;
  ctx: StepContext;
  lang: string;
  info?: Record<string, string>;
  /** Already-captured values for this step (e.g. after an offline draft sync). */
  values?: Record<string, unknown>;
  geo?: { lat: number; lng: number };
}

export function buildScreen({ step, ctx, lang, info, values = {}, geo }: ScreenInput): Screen {
  const required = requiredFields(step, ctx);
  const components: Component[] = [];

  if (info && Object.keys(info).length) components.push({ type: 'info_card', data: info });

  for (const f of step.fields) {
    const common = {
      key: f.key,
      label: localize(f.label, lang),
      required: required.has(f.key),
      ...(values[f.key] !== undefined ? { value: values[f.key] } : {}),
    };
    switch (f.type) {
      case 'select':
        components.push({
          type: 'select',
          ...common,
          options: (f.options ?? []).map((o) => ({
            value: o.value,
            label: localize(o.label, lang),
          })),
        });
        break;
      case 'photo':
        components.push({ type: 'photo', ...common, ...(f.ai?.read ? { aiRead: f.ai.read } : {}) });
        break;
      case 'document':
        components.push({
          type: 'document',
          ...common,
          ...(f.docType ? { docType: f.docType } : {}),
          ...(f.ai?.extract ? { aiExtract: true } : {}),
        });
        break;
      default:
        components.push({ type: f.type, ...common });
    }
  }

  return {
    contractVersion: 1,
    step: step.key,
    title: localize(step.title, lang),
    components,
    actions: step.transitions.map((t) => ({
      id: t.action,
      label: localize(t.label, lang),
      style: t.style ?? 'secondary',
    })),
    ...(step.geoCheck && geo ? { geoCheck: { ...geo, radiusM: step.geoCheck.radiusM } } : {}),
  };
}
