import { useState } from 'react';

// M0 hello-world: proves the window, the preload bridge and the CSP. No product code.
export function App() {
  const [reply, setReply] = useState('');

  async function ping() {
    const result = await window.advpipe.app.ping({ message: 'hello' });
    setReply(result.ok ? result.value.reply : `Error: ${result.error}`);
  }

  return (
    <main>
      <h1>advpipe</h1>
      <p>Foundations check: the window, the typed bridge and the CSP.</p>
      <button type="button" onClick={() => void ping()}>
        Ping
      </button>
      <p role="status" data-testid="reply">
        {reply}
      </p>
    </main>
  );
}
