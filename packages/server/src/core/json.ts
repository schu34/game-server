import type { Json } from '@gs/sdk';

/**
 * Deep check that a value survives JSON round-tripping unchanged.
 * Used to catch game bugs (undefined, NaN, Dates, Maps, class instances, cycles)
 * at the moment a game returns state, rather than as silent data loss in the store.
 */
export function assertJson(value: unknown, path = '$', seen = new Set<object>()): asserts value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is a non-finite number`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${path} is a ${typeof value}, which is not JSON`);
  if (seen.has(value)) throw new TypeError(`${path} is a circular reference`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJson(item, `${path}[${i}]`, seen));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`${path} is a ${proto?.constructor?.name ?? 'non-plain'} object, which is not JSON`);
    }
    for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}
