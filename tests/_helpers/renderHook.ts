/**
 * Minimal `renderHook` shim backed by `react-dom` 19 + React 19 `act`.
 *
 * We do not depend on `@testing-library/react` because:
 *   - It is not in the project today and adding it requires user approval.
 *   - The hooks under test are simple and only need an isolated render.
 *
 * The helper returns:
 *   - `result.current` (mutable; updated by `rerender`)
 *   - `rerender(newProps)` to swap props
 *   - `unmount()` to tear down
 *
 * All state updates triggered by the callback run inside `act` so React
 * flushes synchronously, which keeps the tests free of timing flakes.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

export interface RenderHookResult<TResult> {
  current: TResult;
  rerender: (nextProps?: unknown) => void;
  unmount: () => void;
}

export interface RenderHookOptions<TProps> {
  initialProps?: TProps;
  /** Custom container element. Defaults to a fresh `<div>` per test. */
  container?: Element;
}

export function renderHook<TProps, TResult>(
  callback: (props: TProps) => TResult,
  options: RenderHookOptions<TProps> = {},
): RenderHookResult<TResult> {
  const container = options.container ?? document.createElement("div");
  let props: TProps = options.initialProps as TProps;
  let current!: TResult;
  let root: Root | null = null;

  const Inner = () => {
    current = callback(props);
    return null;
  };

  root = createRoot(container);
  act(() => {
    root!.render(createElement(Inner));
  });

  return {
    get current() {
      return current;
    },
    rerender: (nextProps) => {
      if (nextProps !== undefined) props = nextProps as TProps;
      act(() => {
        root!.render(createElement(Inner));
      });
    },
    unmount: () => {
      act(() => {
        root!.unmount();
      });
      root = null;
    },
  };
}