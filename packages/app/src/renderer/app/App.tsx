import { useEffect } from 'react';
import type { AdvpipeApi } from '@advpipe/contracts';
import { ApiProvider, useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { RouterProvider, useRouter } from '../state/router.js';
import { DraftStateProvider } from '../state/drafts.js';
import { PanelStateProvider } from '../state/panels.js';
import { WindowProvider } from '../state/window.js';
import { Callout } from '../components/Callout.js';
import { ContextPage } from '../pages/ContextPage.js';
import { Help } from '../pages/Help.js';
import { ItemDelete, ItemRename } from '../pages/ItemConfirm.js';
import { ItemEdit, ItemNew } from '../pages/ItemEditor.js';
import { Items } from '../pages/Items.js';
import { NewRun } from '../pages/NewRun.js';
import { NotFound } from '../pages/NotFound.js';
import { RunPage } from '../pages/RunPage.js';
import { CleanAll, CleanConfirm, DecideConfirm } from '../pages/RunConfirm.js';
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
      return <RunPage runId={route.id} notice={route.notice} />;
    case 'run-decide':
      return <DecideConfirm runId={route.id} choice={route.choice} />;
    case 'run-clean':
      return <CleanConfirm runId={route.id} />;
    case 'clean-all':
      return <CleanAll />;
    case 'new-run':
      return <NewRun key={route.item ?? ''} item={route.item} />;
    case 'run-context':
      return <ContextPage runId={route.id} />;
    case 'items':
      return <Items />;
    case 'item-new':
      return <ItemNew folder={route.folder} />;
    case 'item-edit':
      return <ItemEdit key={route.path} path={route.path} notice={route.notice} />;
    case 'item-rename':
      return <ItemRename path={route.path} />;
    case 'item-delete':
      return <ItemDelete path={route.path} />;
    case 'help':
      return <Help />;
    default:
      return <NotFound />;
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
        <PanelStateProvider>
          <DraftStateProvider>
            <Routes />
          </DraftStateProvider>
        </PanelStateProvider>
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
