import { Button, FileInput, Group, Modal, Paper, Stack, Text } from '@mantine/core';
import { useState, type ReactElement } from 'react';
import { useApplication, useApiQuery } from '../../data/application.tsx';
import { Panel } from '../../components/molecules/Panel.tsx';
import { t } from '../../i18n/index.ts';
import { ErrorNotice, QueryFeedback } from '../common/feedback.tsx';
import { useOperation } from '../common/operation.ts';
import { uploadedFile } from './upload.ts';

function MaterialReader(input: { id: string; onClose(): void }): ReactElement {
  const [line, setLine] = useState(1),
    material = useApiQuery('materials.read', { id: input.id, line, count: 200 });
  return (
    <Modal
      opened
      onClose={input.onClose}
      title={material.data?.material?.name ?? t('Material')}
      size="xl"
    >
      <Stack>
        <QueryFeedback loading={material.loading} error={material.error ?? material.data?.error} />
        {material.data?.material?.note && (
          <Text c="dimmed" size="sm">
            {material.data.material.note}
          </Text>
        )}
        <pre className="feature-pre">{material.data?.text}</pre>
        <Group justify="space-between">
          <Button
            variant="default"
            disabled={line === 1}
            onClick={() => setLine(Math.max(1, line - 200))}
          >
            {t('Previous')}
          </Button>
          <Text size="sm">
            {line} / {material.data?.totalLines ?? '—'}
          </Text>
          <Button
            variant="default"
            disabled={line + 200 > (material.data?.totalLines ?? 0)}
            onClick={() => setLine(line + 200)}
          >
            {t('Next')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Project context can be uploaded, read and downloaded independently of a run. */
export function MaterialsPage(input: { projectId: string }): ReactElement {
  const { client } = useApplication(),
    materials = useApiQuery('materials.list', { projectId: input.projectId }),
    action = useOperation();
  const [files, setFiles] = useState<File[]>([]),
    [selected, setSelected] = useState<string>();
  async function upload(): Promise<void> {
    for (const file of files) {
      const result = await action.perform(async () => {
        const uploaded = await client.call('materials.upload', {
          projectId: input.projectId,
          name: file.name,
          contentBase64: await uploadedFile({ file }),
        });
        return { ok: uploaded.ok, error: uploaded.error };
      });
      if (!result.ok) return;
      setFiles((previous) => previous.filter((candidate) => candidate !== file));
    }
  }
  async function download(id: string): Promise<void> {
    await action.perform(async () => {
      const result = await client.call('materials.download', { id });
      if (!result.ok || result.contentBase64 === undefined)
        return { ok: false, error: result.error };
      const bytes = Uint8Array.from(atob(result.contentBase64), (character) =>
          character.charCodeAt(0),
        ),
        url = URL.createObjectURL(new Blob([bytes], { type: result.material?.mimeType })),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.material?.name ?? 'material';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { ok: true };
    });
  }
  return (
    <Panel
      title={t('Materials')}
      description={t('Files and documents available to agents when they need them.')}
    >
      <Stack>
        <Group align="end">
          <FileInput
            multiple
            label={t('Upload files')}
            value={files}
            onChange={setFiles}
            style={{ flex: 1 }}
            clearable
          />
          <Button loading={action.busy} onClick={() => void upload()} disabled={!files.length}>
            {t('Upload')}
          </Button>
        </Group>
        <ErrorNotice error={action.error} />
        <QueryFeedback loading={materials.loading} error={materials.error} />
        {materials.data?.length === 0 && <Text c="dimmed">{t('No materials yet')}</Text>}
        {materials.data?.map((material) => (
          <Paper key={material.id} withBorder p="md">
            <Group justify="space-between">
              <div>
                <Text fw={500}>{material.name}</Text>
                <Text size="xs" c="dimmed">
                  {material.mimeType} · {(material.bytes / 1024).toFixed(1)} KB
                  {material.taskId ? ` · ${t('Task attachment')}` : ''}
                </Text>
              </div>
              <Group>
                <Button variant="default" onClick={() => setSelected(material.id)}>
                  {t('Read')}
                </Button>
                <Button variant="subtle" onClick={() => void download(material.id)}>
                  {t('Download')}
                </Button>
                <Button
                  variant="subtle"
                  color="red"
                  onClick={() =>
                    void action.perform(async () => {
                      await client.call('materials.delete', { id: material.id });
                      return { ok: true };
                    })
                  }
                >
                  {t('Delete')}
                </Button>
              </Group>
            </Group>
          </Paper>
        ))}
      </Stack>
      {selected && (
        <MaterialReader key={selected} id={selected} onClose={() => setSelected(undefined)} />
      )}
    </Panel>
  );
}
