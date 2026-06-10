import { CTB_VERSION } from '@ctb/shared';

/** Editor shell lands in P2-T1. This is the P0-T1 placeholder. */
export function App() {
  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>CTB editor placeholder</h1>
      <p>v{CTB_VERSION}</p>
    </main>
  );
}
