import { Link } from 'react-router-dom';

/**
 * Shown for any unknown address, and (with adapted copy) for a report id the
 * server does not know.
 */
export default function NotFoundPage({
  title = 'This page does not exist',
  children = 'The address may be mistyped, or the page has moved. Check the link, or carry on from one of these pages.',
}) {
  return (
    <section className="not-found" aria-labelledby="not-found-title">
      <div className="code" aria-hidden="true">
        404
      </div>
      <div>
        <h1 id="not-found-title">{title}</h1>
        <p>{children}</p>
        <div className="actions">
          <Link className="btn primary" to="/">
            Go to platform health
          </Link>
          <Link className="btn" to="/reports">
            Browse reports
          </Link>
        </div>
      </div>
    </section>
  );
}
