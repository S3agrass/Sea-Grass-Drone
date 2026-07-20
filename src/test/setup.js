import '@testing-library/jest-dom';

// jsdom doesn't fully wire up localStorage/sessionStorage in all vitest
// configurations — provide a simple in-memory implementation.
function makeStorage() {
  let store = {};
  return {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
  };
}

Object.defineProperty(global, 'localStorage', { value: makeStorage(), writable: true });
Object.defineProperty(global, 'sessionStorage', { value: makeStorage(), writable: true });

// jsdom has no ResizeObserver — CameraView's detection overlay uses it to
// re-fit the canvas. Provide a no-op stub so components mount in tests.
if (typeof global.ResizeObserver === 'undefined') {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
