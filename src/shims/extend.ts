/** ESM shim for CJS `extend` (used by unified/remark). */

type Obj = Record<string, unknown>;

function isPlainObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default function extend<T>(deep: boolean | T, ...objects: Obj[]): T {
  let target: Obj;
  let start = 0;

  if (typeof deep === "boolean") {
    target = (objects[0] ?? {}) as Obj;
    start = 1;
    if (!deep) {
      for (let i = start; i < objects.length; i++) {
        Object.assign(target, objects[i]);
      }
      return target as T;
    }
  } else {
    target = (deep ?? {}) as Obj;
    start = 0;
  }

  for (let i = start; i < objects.length; i++) {
    const source = objects[i];
    if (!source) continue;
    for (const key of Object.keys(source)) {
      const copy = source[key];
      const current = target[key];
      if (isPlainObject(copy) && isPlainObject(current)) {
        target[key] = extend(true, current, copy as Obj);
      } else if (copy !== undefined) {
        target[key] = copy;
      }
    }
  }

  return target as T;
}
