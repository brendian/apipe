import { EmptyState } from '../components/EmptyState.js';
import { PageHeading } from '../components/PageHeading.js';
import { Link } from '../state/router.js';

/** A route that doesn't exist. Says so and offers the way back; never shows what was asked for. */
export function NotFound() {
  return (
    <>
      <PageHeading>Page not found</PageHeading>
      <EmptyState
        actions={
          <Link to="/runs" className="btn">
            Back to runs
          </Link>
        }
      >
        There is no such page in advpipe.
      </EmptyState>
    </>
  );
}
