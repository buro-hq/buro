import { t } from '../i18n/index.ts';
import { ProjectStoragePanel } from '../components/organisms/ProjectStoragePanel';
import { Button } from '@mantine/core';
import { Notice } from '../components/atoms/Notice';
import { Panel } from '../components/molecules/Panel';
import { ProjectSettings } from '../components/organisms/ProjectSettings';
import { useProject } from '../data/provider';
export function SettingsView() {
  const { snapshot, mode, connection, switchMode } = useProject();
  if (snapshot?.profile)
    return (
      <>
        <ProjectSettings />
        <ProjectStoragePanel />
      </>
    );
  return (
    <Panel
      title={t('Project settings')}
      description={t('Connection and capabilities of the current source')}
    >
      <div className="setting-row">
        <div>
          <b>{t('Data source')}</b>
          <p>{mode === 'service' ? t('Local service') : t('Offline drafts')}</p>
        </div>
        <span className="micro muted">{mode === 'service' ? connection : t('Read only')}</span>
      </div>
      <Notice>
        {mode === 'service'
          ? t(
              'This is a demo project. Connect your Git repository in Projects to configure execution.',
            )
          : t('Drafts are saved in this browser. Connect to the service to execute goals.')}
      </Notice>
      {mode === 'replay' && (
        <Button variant="default" onClick={() => void switchMode('service')}>
          {t('Connect local service')}
        </Button>
      )}
    </Panel>
  );
}
