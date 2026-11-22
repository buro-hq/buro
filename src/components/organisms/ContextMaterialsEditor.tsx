import { t } from '../../i18n/index.ts';
import { ActionIcon, Button, FileButton, Group, Stack, Text } from '@mantine/core';
import { FileText, FolderOpen, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ContextMaterial } from '../../../protocol/context';
import { useProject } from '../../data/provider';
import { LocalPathDialog } from '../molecules/LocalPathDialog';

const sizeLabel = (size: number) =>
  size < 1024
    ? t('{p0} B', { p0: size })
    : size < 1024 * 1024
      ? t('{p0} KB', { p0: Math.ceil(size / 1024) })
      : t('{p0} MB', { p0: (size / 1024 / 1024).toFixed(1) });
export function ContextMaterialsEditor({
  projectId,
  root,
  scope,
  value = [],
  onChange,
  onBusyChange,
}: {
  projectId?: string;
  root?: string;
  scope: 'project' | 'goal';
  value?: string[];
  onChange?: (ids: string[]) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { client, mode, snapshot } = useProject();
  const [catalog, setCatalog] = useState<ContextMaterial[]>([]),
    [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const selection = useRef(value);
  selection.current = value;
  const supported = mode === 'service' && snapshot?.capabilities.includes('context.import');
  useEffect(() => {
    let active = true;
    setCatalog([]);
    if (projectId && supported) {
      if (snapshot?.project.id === projectId) setCatalog(snapshot.contextMaterials || []);
      else
        void client
          ?.command<ContextMaterial[]>({ method: 'context.list', params: { projectId } })
          .then((items) => {
            if (active) setCatalog(items);
          })
          .catch((e) => {
            if (active) setError(e.message);
          });
    }
    return () => {
      active = false;
    };
  }, [projectId, client, supported, snapshot?.project.id, snapshot?.contextMaterials]);
  const items =
    scope === 'project'
      ? catalog.filter((m) => m.active && m.scope === 'project')
      : catalog.filter((m) => value.includes(m.id));
  const inherited = catalog.filter((m) => m.active && m.scope === 'project').length;
  async function importMaterials(input: {
    paths?: string[];
    upload?: { name: string; base64: string };
  }) {
    if (!projectId || !client) return;
    if ((input.paths?.length || 0) > 32)
      throw Error(t('Choose up to 32 files or directories at a time.'));
    const imported = await client.command<ContextMaterial[]>({
      method: 'context.import',
      params: { projectId, scope, ...input },
    });
    setCatalog((current) => [
      ...current.filter((m) => !imported.some((x) => x.id === m.id)),
      ...imported,
    ]);
    if (scope === 'goal') {
      const ids = [...new Set([...selection.current, ...imported.map((m) => m.id)])];
      selection.current = ids;
      onChange?.(ids);
    }
  }
  async function work(action: () => Promise<void>) {
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  async function upload(files: File[]) {
    for (const file of files) {
      if (file.size > 8 * 1024 * 1024)
        throw Error(t('{p0}: maximum file size is 8 MB.', { p0: file.name }));
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(Error(t('Could not read the file.')));
        reader.readAsDataURL(file);
      });
      await importMaterials({ upload: { name: file.name, base64 } });
    }
  }
  return (
    <Stack
      gap="xs"
      component="section"
      aria-label={scope === 'project' ? t('Project materials') : t('Goal materials')}
    >
      <Text size="sm" fw={500}>
        {scope === 'project' ? t('Project materials') : t('Goal materials')}
      </Text>
      <Text size="xs" c="dimmed">
        {scope === 'project'
          ? t('Shared context for future goals. Additions and removals are saved immediately.')
          : t('Additional context for this goal.')}{' '}
        {t(
          'Text, code, images, PDF and DOCX; up to 8 MB per file. Copies are stored locally and shared with agents during execution.',
        )}
      </Text>
      {scope === 'goal' && inherited > 0 && (
        <Text size="xs" c="dimmed">
          {t('Project materials will also be available:')} {inherited}.
        </Text>
      )}
      {items.map((material) => (
        <Group
          key={material.id}
          wrap="nowrap"
          gap="xs"
          style={{
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 6,
            padding: '6px 10px',
          }}
        >
          <FileText size={16} style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" truncate title={material.name}>
              {material.name}
            </Text>
            <Text size="xs" c="dimmed">
              {sizeLabel(material.size)}
              {material.note ? ` · ${material.note}` : ''}
            </Text>
          </div>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={t('Remove material {p0}', { p0: material.name })}
            disabled={busy}
            onClick={() =>
              void work(async () => {
                if (scope === 'goal') onChange?.(value.filter((id) => id !== material.id));
                else {
                  await client!.command({
                    method: 'context.remove',
                    params: { projectId: projectId!, materialId: material.id },
                  });
                  setCatalog((c) =>
                    c.map((m) => (m.id === material.id ? { ...m, active: false } : m)),
                  );
                }
              })
            }
          >
            <X size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group gap="xs">
        <Button
          size="xs"
          variant="default"
          leftSection={<FolderOpen size={14} />}
          disabled={busy || !projectId || !supported}
          onClick={() => setOpened(true)}
        >
          {t('Choose on computer')}
        </Button>
        <FileButton multiple onChange={(files) => void work(() => upload(files))}>
          {(props) => (
            <Button
              {...props}
              size="xs"
              variant="default"
              leftSection={<Upload size={14} />}
              loading={busy}
              disabled={!projectId || !supported}
            >
              {t('Upload files')}
            </Button>
          )}
        </FileButton>
      </Group>
      {!projectId && (
        <Text size="xs" c="dimmed">
          {t('Connect the project before adding materials.')}
        </Text>
      )}
      {!supported && (
        <Text size="xs" c="dimmed">
          {t('Materials require an updated local service.')}
        </Text>
      )}
      {error && (
        <Text c="red" size="sm" role="alert">
          {t(error)}
        </Text>
      )}
      <LocalPathDialog
        opened={opened}
        onClose={() => setOpened(false)}
        title={t('Add context materials')}
        initialPath={root}
        kind="both"
        multiple
        onSelect={(entries) =>
          void work(() => importMaterials({ paths: entries.map((e) => e.path) }))
        }
      />
    </Stack>
  );
}
