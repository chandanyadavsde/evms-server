import {
  type IntakeMaster,
  intakeInstructions,
  intakeSchema,
  type RawIntake,
} from '../../domain/intake';
import type { FileInput } from '../ai/extractor';
import { ModelError, type VisionModel } from '../ai/llm';

/**
 * The reasoning layer behind smart intake. Readers differ only in how they read; the checks
 * against master data (domain/intake.ts) are the same for all of them.
 */

export interface IntakeInput {
  text?: string;
  files: FileInput[];
}

export interface IntakeReader {
  /** Shown on the intake screen: which AI (or rules) read this. */
  readonly name: string;
  /** Whether this reader can read images (rules without OCR read text only). */
  readonly readsImages: boolean;
  /** US$ spent since the server started, when the provider reports cost. */
  readonly spentUsd?: number;
  read(input: IntakeInput, master: IntakeMaster, now: Date): Promise<RawIntake>;
}

/** Input the reader cannot handle (no image reading, quota, declined) — shown to the manager. */
export class IntakeError extends Error {}

/** Claude or Gemini: reads any message or screenshot and reasons about what is asked. */
export class LlmIntakeReader implements IntakeReader {
  readonly readsImages = true;
  constructor(private llm: VisionModel) {}

  get spentUsd() {
    return this.llm.spentUsd;
  }

  get name() {
    return this.llm.name;
  }

  async read(input: IntakeInput, master: IntakeMaster, now: Date): Promise<RawIntake> {
    const text = input.text?.trim();
    try {
      const raw = await this.llm.json({
        system: intakeInstructions(master, now),
        parts: [
          ...input.files,
          {
            text: text
              ? `Pasted text:\n"""\n${text}\n"""`
              : 'Read the attached screenshot(s) and return what is asked.',
          },
        ],
        schema: intakeSchema(),
        maxTokens: 8000,
      });
      return raw as RawIntake;
    } catch (err) {
      if (err instanceof ModelError) throw new IntakeError(err.message);
      throw err;
    }
  }
}
