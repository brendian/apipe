import { useState } from 'react';

/** The clipboard API refuses an unfocused page; the old selection route doesn't. */
function legacyCopy(text: string): boolean {
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.className = 'visually-hidden';
  document.body.append(box);
  box.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    box.remove();
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

/** A command to copy and run in your own terminal. The app never runs it. */
export function CommandBox({ command, label }: { command: string; label: string }) {
  const [message, setMessage] = useState('');
  function copy(): void {
    void copyText(command).then((ok) => {
      setMessage(ok ? 'Copied' : "Couldn't copy: select the command and copy it yourself.");
      setTimeout(() => setMessage(''), 3000);
    });
  }
  return (
    <div className="command-box">
      <code tabIndex={0} aria-label={label}>
        {command}
      </code>
      <button type="button" className="btn" onClick={copy}>
        Copy
        <span className="visually-hidden"> {label}</span>
      </button>
      <span role="status" className={message === 'Copied' ? 'visually-hidden' : 'muted'}>
        {message}
      </span>
    </div>
  );
}
