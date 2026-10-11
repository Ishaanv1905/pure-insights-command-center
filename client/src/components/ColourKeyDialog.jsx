import { useEffect, useRef, useState } from 'react';
import { KEY_ENTRIES, TONES, toneClass } from '../theme/colourKey.js';
import { AlertStatusBadge, Badge, CloseIcon, SeverityBadge } from './ui.jsx';

/**
 * "Colour key" button for the nav row. Opens a native modal <dialog>: focus is
 * trapped and Escape closes it (platform behaviour); clicking the backdrop
 * closes it too. Focus returns to the button on close.
 */
export default function ColourKeyButton() {
  const dialogRef = useRef(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    // closedby="any": Escape and a click on the backdrop close it (set here because
    // React does not know the attribute yet).
    dialog.setAttribute('closedby', 'any');
    const onClose = () => setOpen(false);
    // Light dismiss for browsers without <dialog>.
    const onClick = (event) => {
      if ('closedBy' in HTMLDialogElement.prototype || event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside =
        r.top <= event.clientY && event.clientY <= r.bottom && r.left <= event.clientX && event.clientX <= r.right;
      if (!inside) dialog.close();
    };
    dialog.addEventListener('close', onClose);
    dialog.addEventListener('click', onClick);
    return () => {
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('click', onClick);
    };
  }, []);

  function show() {
    dialogRef.current?.showModal();
    setOpen(true);
  }

  return (
    <>
      <button
        type="button"
        className="text-button key-button"
        onClick={show}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <KeyGlyph />
        <span className="key-label">Colour key</span>
      </button>
      <dialog ref={dialogRef} className="key-dialog" aria-labelledby="colour-key-title">
        <div className="dialog-head">
          <div>
            <h2 id="colour-key-title">Colour key</h2>
            <p>Colour always means the same thing on every page. Teal is used only for links and buttons.</p>
          </div>
          <form method="dialog">
            <button className="icon-button" aria-label="Close colour key">
              <CloseIcon />
            </button>
          </form>
        </div>
        <div className="dialog-body">
          <ul className="key-list">
            {KEY_ENTRIES.map((entry) => {
              const tone = TONES[entry.tone];
              return (
                <li key={entry.tone} className={toneClass(entry.tone)}>
                  <span className="swatch" aria-hidden="true" />
                  <div>
                    <span className="key-name">
                      {tone.name}: {tone.title.toLowerCase()}.
                    </span>{' '}
                    <span className="key-meaning">{tone.meaning}</span>
                  </div>
                  <span className="badges">
                    {entry.examples.map((ex) => (
                      <Badge key={ex} tone={entry.tone}>
                        {ex}
                      </Badge>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="key-grammar">
            <div>
              Severity is a filled badge: <SeverityBadge severity="critical" /> <SeverityBadge severity="warning" />
            </div>
            <div>
              Alert status is an outlined badge: <AlertStatusBadge status="OPEN" />{' '}
              <AlertStatusBadge status="ACKNOWLEDGED" /> <AlertStatusBadge status="RESOLVED" />
            </div>
            <div>Numbers are coloured only when they cross a threshold, such as a load time over 15 s.</div>
          </div>
        </div>
      </dialog>
    </>
  );
}

function KeyGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect className="tone-critical" x="0" y="0" width="6" height="6" rx="1.5" style={{ fill: 'var(--tone)' }} />
      <rect className="tone-warning" x="8" y="0" width="6" height="6" rx="1.5" style={{ fill: 'var(--tone)' }} />
      <rect className="tone-healthy" x="0" y="8" width="6" height="6" rx="1.5" style={{ fill: 'var(--tone)' }} />
      <rect className="tone-dq" x="8" y="8" width="6" height="6" rx="1.5" style={{ fill: 'var(--tone)' }} />
    </svg>
  );
}
