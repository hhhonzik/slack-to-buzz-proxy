export class InputError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
export const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export const str = (v: unknown): string => typeof v === 'string' ? v : '';
export const join = (parts: (string | undefined)[], separator = '\n\n') => parts.filter(Boolean).join(separator);
export interface RenderOptions { users?: Record<string, string>; allowBroadcast?: boolean }
export interface Rendered { content: string; mentions: string[]; broadcast: boolean; warnings: string[]; format: 'slack' | 'alertmanager' }

// Bound recursion and work before traversing caller-controlled JSON.
export function validateTree(value: unknown): asserts value is Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(400, 'invalid_payload');
  let nodes = 0;
  const walk = (v: unknown, depth: number) => {
    if (++nodes > 30000 || depth > 24) throw new InputError(400, 'payload_too_complex');
    if (v && typeof v === 'object') for (const child of Object.values(v)) walk(child, depth + 1);
  };
  walk(value, 0);
}
