import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractionTemplate } from '@vms/contracts';
import { describe, expect, it } from 'vitest';
import { findContainerNumbers, findDate, parseOcr } from '../src/modules/ai/ocr';

const tpl = (key: string): ExtractionTemplate =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', 'config', 'extraction-templates', `${key}.v2.json`),
      'utf8',
    ),
  );
const lines = (...texts: string[]) => texts.map((text) => ({ text, confidence: 88 }));

describe('local OCR parsing (free reader)', () => {
  it('finds container numbers and repairs OCR look-alikes using the check digit', () => {
    expect(findContainerNumbers('MSKU9O7O323 discharged')).toEqual([
      { number: 'MSKU9070323', repaired: true },
    ]);
    expect(findContainerNumbers('CSQU 305438-3')).toEqual([
      { number: 'CSQU3054383', repaired: false },
    ]);
    expect(findContainerNumbers('CSQU3054384')).toEqual([]); // wrong check digit: not a container
    // Real Tesseract output from a portal screenshot: "8" read as "S" — the check digit picks 8, not 5.
    expect(findContainerNumbers('TGHUS791306 ~ 40HC Customs hold')).toEqual([
      { number: 'TGHU8791306', repaired: true },
    ]);
  });

  it('does not mistake a yard code for a date', () => {
    expect(findDate('B12-04-3 08/10/2026 18:00')).toBe('2026-10-08T18:00');
  });

  it('reads Indian date formats', () => {
    expect(findDate('Valid till 08/10/2026 18:00')).toBe('2026-10-08T18:00');
    expect(findDate('08-Oct-2026 6:30')).toBe('2026-10-08T06:30');
    expect(findDate('nothing here')).toBeNull();
  });

  it('portal screenshot: one record per container row, status/size/yard from the row', () => {
    const r = parseOcr(
      tpl('portal_container_status'),
      lines(
        'NSICT - Container Enquiry',
        'Container No   Size  Status               Yard       Valid Till',
        'MSKU9O7O323    20GP  Ready for delivery   B12-04-3   08/10/2026 18:00',
        'TGHU8791306    40HC  Customs hold                    ',
        'Total: 2 records',
      ),
    );
    expect(r.records).toHaveLength(2);
    const [a, b] = r.records;
    expect(a?.container_number?.value).toBe('MSKU9070323');
    expect(a?.status?.value).toBe('Ready for delivery');
    expect(a?.size_type?.value).toBe('20GP');
    expect(a?.yard_location?.value).toBe('B12-04-3');
    expect(a?.valid_till?.value).toBe('2026-10-08T18:00');
    expect(a?.terminal?.value).toBe('NSICT'); // from the page heading
    expect(b?.status?.value).toBe('Customs hold');
    expect(b?.valid_till?.value).toBeNull();
  });

  it('port receipt: values after printed labels', () => {
    const r = parseOcr(
      tpl('port_receipt'),
      lines(
        'JAWAHARLAL NEHRU PORT - NSICT',
        'Receipt No: R-889214',
        'Container: CSQU3054383',
        'Vehicle No : MH46 EV 1001',
        'Date & Time: 07/10/2026 14:22',
        'Seal No - SL998877',
      ),
    );
    const rec = r.records[0];
    expect(rec?.receipt_number?.value).toBe('R-889214');
    expect(rec?.container_number?.value).toBe('CSQU3054383');
    expect(rec?.vehicle_number?.value).toBe('MH46 EV 1001');
    expect(rec?.issued_at?.value).toBe('2026-10-07T14:22');
    expect(rec?.seal_number?.value).toBe('SL998877');
    expect(rec?.terminal?.value).toBe('NSICT');
  });

  it('odometer photo: takes the large total, not the trip meter', () => {
    const r = parseOcr(tpl('odometer'), lines('TRIP 132.4', 'ODO 12,460 km'));
    expect(r.records[0]?.reading?.value).toBe(12460);
  });

  it('battery display: percentage', () => {
    expect(
      parseOcr(tpl('battery_soc'), lines('SOC 64 %', 'Range 180 km')).records[0]?.reading?.value,
    ).toBe(64);
  });

  it('says so when nothing matches', () => {
    const r = parseOcr(tpl('port_receipt'), lines('a photo of a cat'));
    expect(r.records).toEqual([]);
    expect(r.notes).toContain('No matching values');
  });
});
