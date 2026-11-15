import { t } from '../../i18n/index.ts';
import {
  ActionIcon,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { ArrowUp, File, Folder, Home, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LocalDirectory, LocalEntry } from '../../../protocol/context';
import { useProject } from '../../data/provider';

export function LocalPathDialog({
  opened,
  onClose,
  onSelect,
  title = t('Choose directory'),
  initialPath,
  projectId,
  restricted = false,
  kind = 'directory',
  multiple = false,
}: {
  opened: boolean;
  onClose: () => void;
  onSelect: (entries: LocalEntry[]) => void;
  title?: string;
  initialPath?: string;
  projectId?: string;
  restricted?: boolean;
  kind?: 'directory' | 'file' | 'both';
  multiple?: boolean;
}) {
  const { client } = useProject();
  const [directory, setDirectory] = useState<LocalDirectory>(),
    [address, setAddress] = useState(''),
    [query, setQuery] = useState(''),
    [hidden, setHidden] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<LocalEntry[]>([]);
  const generation = useRef(0);
  async function load(path?: string, showHidden = hidden, search = query) {
    if (!client) return;
    const version = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await client.command<LocalDirectory>({
        method: 'filesystem.list',
        params: { path: path || undefined, projectId, restricted, showHidden, query: search },
      });
      if (version !== generation.current) return;
      setDirectory(result);
      setAddress(result.path);
    } catch (e) {
      if (version === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (opened) {
      setSelected([]);
      setQuery('');
      setDirectory(undefined);
      void load(initialPath, hidden, '');
    }
    return () => {
      generation.current++;
    };
    // Start a fresh browsing session when opened; navigation is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, projectId]);
  function toggle(entry: LocalEntry) {
    if (!entry.selectable || (kind !== 'both' && entry.kind !== kind)) return;
    setSelected((previous) =>
      previous.some((p) => p.path === entry.path)
        ? previous.filter((p) => p.path !== entry.path)
        : multiple
          ? [...previous, entry]
          : [entry],
    );
  }
  const current: LocalEntry | undefined = directory
    ? {
        name: directory.path.split('/').pop() || '/',
        path: directory.path,
        kind: 'directory',
        selectable: true,
      }
    : undefined;
  const result = selected.length ? selected : kind !== 'file' && current ? [current] : [];
  return (
    <Modal opened={opened} onClose={onClose} title={title} size="lg" centered zIndex={400}>
      <Stack gap="sm">
        <Group wrap="nowrap" gap="xs">
          <ActionIcon
            variant="default"
            aria-label={t('Home directory')}
            disabled={busy}
            onClick={() => {
              setQuery('');
              void load(directory?.home, hidden, '');
            }}
          >
            <Home size={16} />
          </ActionIcon>
          <ActionIcon
            variant="default"
            aria-label={t('Parent directory')}
            disabled={busy || !directory || directory.parent === directory.path}
            onClick={() => {
              setQuery('');
              void load(directory?.parent, hidden, '');
            }}
          >
            <ArrowUp size={16} />
          </ActionIcon>
          <TextInput
            aria-label={t('Directory address')}
            value={address}
            onChange={(e) => setAddress(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setQuery('');
                void load(address, hidden, '');
              }
            }}
            style={{ flex: 1 }}
          />
          <Button
            variant="default"
            size="xs"
            disabled={busy}
            onClick={() => {
              setQuery('');
              void load(address, hidden, '');
            }}
          >
            {t('Open')}
          </Button>
        </Group>
        <Group justify="space-between">
          <TextInput
            aria-label={t('Search directory')}
            placeholder={t('Search directory')}
            leftSection={<Search size={14} />}
            value={query}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setQuery(value);
              void load(directory?.path, hidden, value);
            }}
          />
          <Checkbox
            label={t('Hidden files')}
            checked={hidden}
            onChange={(e) => {
              const value = e.currentTarget.checked;
              setHidden(value);
              void load(directory?.path, value);
            }}
          />
        </Group>
        {error && (
          <Text c="red" size="sm" role="alert">
            {t(error)}
          </Text>
        )}
        <ScrollArea h={320} type="auto" aria-label={t('Directory contents')}>
          {busy ? (
            <Group justify="center" p="xl">
              <Loader size="sm" />
            </Group>
          ) : (
            <Stack gap={2}>
              {directory?.entries.map((entry) => (
                <Group
                  key={entry.path}
                  wrap="nowrap"
                  gap="xs"
                  px="xs"
                  py={4}
                  style={{
                    borderRadius: 6,
                    background: selected.some((p) => p.path === entry.path)
                      ? 'var(--mantine-primary-color-light)'
                      : undefined,
                  }}
                >
                  <Checkbox
                    aria-label={t('Select {p0}', { p0: entry.name })}
                    checked={selected.some((p) => p.path === entry.path)}
                    disabled={!entry.selectable || (kind !== 'both' && entry.kind !== kind)}
                    onChange={() => toggle(entry)}
                  />
                  <Button
                    fullWidth
                    justify="flex-start"
                    variant="subtle"
                    color="gray"
                    leftSection={
                      entry.kind === 'directory' ? <Folder size={16} /> : <File size={16} />
                    }
                    disabled={!entry.selectable}
                    onClick={() => {
                      if (entry.kind === 'directory') {
                        setQuery('');
                        void load(entry.path, hidden, '');
                      } else toggle(entry);
                    }}
                    styles={{
                      label: { overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' },
                    }}
                  >
                    {entry.name}
                    {!entry.selectable ? t(' · symlink') : ''}
                  </Button>
                </Group>
              ))}
              {directory && !directory.entries.length && (
                <Text size="sm" c="dimmed" p="md">
                  {t('The directory is empty or nothing matched.')}
                </Text>
              )}
            </Stack>
          )}
        </ScrollArea>
        {directory?.truncated && (
          <Text size="xs" c="dimmed">
            {t('Showing the first 1000 entries. Refine your search.')}
          </Text>
        )}
        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          {selected.length
            ? t('Selected: {p0} · {p1}', {
                p0: selected.length,
                p1: selected.map((p) => p.name).join(', '),
              })
            : kind === 'file'
              ? t('Choose a file')
              : t('Current directory: {p0}', { p0: directory?.path || '…' })}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={busy || !result.length || !!error}
            onClick={() => {
              onSelect(result);
              onClose();
            }}
          >
            {t('Select')}
            {selected.length > 1 ? ` (${selected.length})` : ''}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
