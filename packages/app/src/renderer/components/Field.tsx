import { useId, type ReactNode } from 'react';

type ControlProps = { id: string; 'aria-describedby'?: string };

/**
 * A labelled form control. The name is the label alone (a real `<label for>`); the help text is
 * the control's description, so a screen reader doesn't read it into the name.
 */
export function Field({
  label,
  help,
  hiddenLabel = false,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  hiddenLabel?: boolean;
  children: (props: ControlProps) => ReactNode;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="field">
      <label htmlFor={id} className={hiddenLabel ? 'visually-hidden' : undefined}>
        {label}
      </label>
      {children({ id, ...(help ? { 'aria-describedby': helpId } : {}) })}
      {help ? <small id={helpId}>{help}</small> : null}
    </div>
  );
}
