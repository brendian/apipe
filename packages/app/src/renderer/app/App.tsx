import { useEffect } from 'react';
import type { AdvpipeApi } from '@advpipe/contracts';
import { ApiProvider, useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { RouterProvider, useRouter } from '../state/router.js';
import { WindowProvider } from '../state/window.js';
import { Callout } from '../components/Callout.js';
import { Placeholder } from '../pages/Placeholder.js';
import { RunPage } from '../pages/RunPage.js';
import { Runs } from '../pages/Runs.js';
import { Welcome } from '../pages/Welcome.js';
import { Shell } from './Shell.js';

function Routes() {
  const { route } = useRouter();
  switch (route.name) {
    case 'boot':
      return <p>Loading…</p>;
    case 'welcome':
      return <Welcome />;
    case 'runs':
      return <Runs />;
    case 'run':
      return <RunPage runId={route.id} />;
    case 'new-run':
      return <Placeholder title="New run" />;
    case 'run-context':
      return <Placeholder title="Spec & context" />;
    case 'items':
      return <Placeholder title="Work items" />;
    case 'help':
      return <Placeholder title="Help" />;
    default:
      return <Placeholder title="Not found" />;
  }
}

/** Where a window starts: welcome when it has no repo or the setup checks fail, else the runs. */
function Boot({ hasRepo }: { hasRepo: boolean }) {
  const api = useApi();
  const { replace, route } = useRouter();
  useEffect(() => {
    if (route.name !== 'boot') return;
    if (!hasRepo) return replace('/welcome');
    void api.app.preflight({}).then((r) => {
      replace(r.ok && r.value.git.ok && r.value.repo.ok ? '/runs' : '/welcome');
    });
  }, [api, hasRepo, replace, route.name]);
  return null;
}

function Ready() {
  const api = useApi();
  const info = useRemote(() => api.app.window.info({}), [api]);
  const prefs = useRemote(() => api.app.prefs.get({}), [api]);
  if (info.state.status === 'error') return <Callout tone="bad">{info.state.error}</Callout>;
  if (info.state.status !== 'ready' || prefs.state.status !== 'ready') return <p>Loading…</p>;
  const { repo } = info.state.value;
  return (
    <WindowProvider value={{ repo, initialFilter: prefs.state.value.run_filter }}>
      <Boot hasRepo={repo !== null} />
      <Shell theme={prefs.state.value.theme}>
        <Routes />
      </Shell>
    </WindowProvider>
  );
}

export function App({ api }: { api: AdvpipeApi }) {
  return (
    <ApiProvider api={api}>
      <RouterProvider initial="/boot">
        <Ready />
      </RouterProvider>
    </ApiProvider>
  );
}
