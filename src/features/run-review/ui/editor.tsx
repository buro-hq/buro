import { Button, Group, NumberInput, Paper, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import type { ReactElement } from 'react';
import type { ReviewSettings, ReviewParticipant } from '#shared/contracts';
import type { AvailableModel } from '../../../../agent/contracts/model.ts';
import { t } from '@/i18n/index.ts';

/** Controlled team settings, shared by application defaults and explicit run overrides. */
export interface ReviewEditorProps {
  value: ReviewSettings;
  models: AvailableModel[];
  onChange(value: ReviewSettings): void;
}

/** Reviewer names and instructions are editable data, independent of execution roles. */
export const ReviewEditor = ({ value, models, onChange }: ReviewEditorProps): ReactElement => {
  const participants = value.participants ?? [];
  const change = (index: number, changes: Partial<ReviewParticipant>): void => {
    onChange({
      ...value,
      participants: participants.map((participant, position) => position === index
        ? { ...participant, ...changes }
        : participant),
    });
  };
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('Independent sessions review the result. Findings return to the executor for corrections and another review.')}
      </Text>
      {participants.map((participant, index) => (
        <Paper withBorder p="md" key={index}>
          <Stack gap="sm">
            <TextInput
              label={t('Reviewer name')}
              value={participant.name}
              onChange={(event) => change(index, {
                name: event.currentTarget.value,
              })}
            />
            <Select
              label={t('Reviewer model')}
              placeholder={t('Same model as executor')}
              clearable
              value={participant.modelId ?? null}
              data={models.map((model) => ({ value: model.id, label: model.name ?? model.id }))}
              onChange={(modelId) => change(index, {
                modelId,
              })}
            />
            <Textarea
              label={t('Review focus')}
              value={participant.instructions}
              onChange={(event) => change(index, {
                instructions: event.currentTarget.value,
              })}
              autosize
              minRows={3}
            />
            <Button
              variant="subtle"
              color="red"
              onClick={() => onChange({
                ...value,
                participants: participants.filter((_, position) => position !== index),
              })}
            >
              {t('Remove reviewer')}
            </Button>
          </Stack>
        </Paper>
      ))}
      <Group>
        <Button
          variant="default"
          onClick={() => onChange({
            ...value,
            participants: [...participants, { name: t('Reviewer'), instructions: '' }],
          })}
        >
          {t('Add reviewer')}
        </Button>
      </Group>
      <NumberInput
        label={t('Maximum review rounds')}
        description={t('Optional. Leave empty to continue until there are no actionable findings.')}
        value={value.maxRounds ?? ''}
        allowDecimal={false}
        min={1}
        onChange={(rounds) => onChange({
          ...value,
          maxRounds: typeof rounds === 'number' ? rounds : null,
        })}
      />
    </Stack>
  );
};
