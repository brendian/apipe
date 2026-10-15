import { EmptyState } from '../components/EmptyState.js';
import { PageHeading } from '../components/PageHeading.js';
import { Link } from '../state/router.js';

/** A screen that a later milestone builds (docs/11): present in the navigation, honest about it. */
export function Placeholder({ title }: { title: string }) {
  return (
    <>
      <PageHeading>{title}</PageHeading>
      <EmptyState
        actions={
          <Link to="/runs" className="btn">
            Back to runs
          </Link>
        }
      >
        This screen is not built yet.
      </EmptyState>
    </>
  );
}
