import { t } from '../../i18n/index.ts';
import { ActionIcon, Button, Group, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { FolderOpen, Plus } from 'lucide-react';
import { useState } from 'react';
import type { LocalEntry } from '../../../protocol/context';
import { useProject } from '../../data/provider';
import { LocalPathDialog } from './LocalPathDialog';

function relative(entry: LocalEntry, root?: string) {
  if (!root) return entry.path;
  const base = root.replace(/\/$/, '');
  if (entry.path === base) return './';
  if (!entry.path.startsWith(base + '/')) throw Error(t('Choose a path inside the repository.'));
  return entry.path.slice(base.length + 1) + (entry.kind === 'directory' ? '/' : '');
}
export function PathInput({
  label,
  value,
  onChange,
  description,
  placeholder,
  disabled,
  root,
  projectId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  placeholder?: string;
  disabled?: boolean;
  root?: string;
  projectId?: string;
}) {
  const { snapshot, mode } = useProject();
  const [opened, setOpened] = useState(false),
    [error, setError] = useState('');
  const canBrowse = mode === 'service' && snapshot?.capabilities.includes('filesystem.list');
  const initial = root
    ? root.replace(/\/$/, '') + '/' + (value === './' ? '' : value)
    : value || undefined;
  return (
    <>
      <TextInput
        label={label}
        description={description}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        error={error ? t(error) : undefined}
        onChange={(e) => {
          setError('');
          onChange(e.currentTarget.value);
        }}
        rightSection={
          <ActionIcon
            variant="subtle"
            aria-label={t('Choose: {p0}', { p0: label })}
            disabled={disabled || !canBrowse}
            onClick={() => setOpened(true)}
          >
            <FolderOpen size={17} />
          </ActionIcon>
        }
      />
      <LocalPathDialog
        opened={opened}
        onClose={() => setOpened(false)}
        title={t('Choose: {p0}', { p0: label })}
        initialPath={initial}
        projectId={projectId}
        restricted={!!root && !!projectId}
        onSelect={(entries) => {
          try {
            onChange(relative(entries[0], root));
            setError('');
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
    </>
  );
}
export function PathListInput({
  label,
  description,
  value,
  onChange,
  root,
  projectId,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  root?: string;
  projectId?: string;
}) {
  const { snapshot, mode } = useProject();
  const [opened, setOpened] = useState(false),
    [error, setError] = useState('');
  return (
    <Stack gap={5}>
      <Textarea
        label={label}
        description={description}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        minRows={3}
      />
      <Group>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<Plus size={13} />}
          disabled={mode !== 'service' || !snapshot?.capabilities.includes('filesystem.list')}
          onClick={() => setOpened(true)}
        >
          {t('Choose files and directories')}
        </Button>
      </Group>
      {error && (
        <Text c="red" size="xs">
          {t(error)}
        </Text>
      )}
      <LocalPathDialog
        opened={opened}
        onClose={() => setOpened(false)}
        title={label}
        initialPath={root}
        projectId={projectId}
        restricted={!!projectId}
        kind="both"
        multiple
        onSelect={(entries) => {
          try {
            const paths = entries.map((e) => relative(e, root));
            onChange([...new Set([...value.split('\n').filter(Boolean), ...paths])].join('\n'));
            setError('');
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
    </Stack>
  );
}
