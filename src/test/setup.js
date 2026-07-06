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
