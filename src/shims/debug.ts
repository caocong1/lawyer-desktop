/** Browser shim for the CJS `debug` package (used by remark/micromark). */

export type Debugger = ((...args: unknown[]) => void) & { namespace: string };

export default function debug(namespace: string): Debugger {
  const fn = (..._args: unknown[]) => {};
  fn.namespace = namespace;
  return fn;
}
